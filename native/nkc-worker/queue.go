package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	queueRequestFrameLimit  = 3 * 1024 * 1024
	queueResponseFrameLimit = 2 * 1024 * 1024
)

type friendRoute struct {
	AccountID    string `json:"accountId"`
	FriendID     string `json:"friendId"`
	OnionAddress string `json:"onionAddress"`
}

type queuedMessage struct {
	AccountID       string `json:"accountId"`
	ID              string `json:"id"`
	FriendID        string `json:"friendId"`
	OnionAddress    string `json:"onionAddress"`
	Payload         string `json:"payload"`
	PayloadFormat   string `json:"payloadFormat,omitempty"`
	InboxWriteToken string `json:"inboxWriteToken,omitempty"`
	Status          string `json:"status"`
	CreatedAt       int64  `json:"createdAt"`
	UpdatedAt       int64  `json:"updatedAt"`
	DeliveredAt     int64  `json:"deliveredAt,omitempty"`
	LastError       string `json:"lastError,omitempty"`
	Attempts        int    `json:"attempts,omitempty"`
	NextAttemptAt   int64  `json:"nextAttemptAt,omitempty"`
	FailedAt        int64  `json:"failedAt,omitempty"`
	// Opt-in ownership fingerprint survives payload removal after HTTP acceptance.
	// Never copy this value into diagnostic output.
	ImmutablePayloadDigest string `json:"immutablePayloadDigest,omitempty"`
	TransportRetryDigest   string `json:"transportRetryDigest,omitempty"`
}

type queueFile struct {
	Friends        []friendRoute              `json:"friends"`
	Messages       []queuedMessage            `json:"messages"`
	RevokedDevices map[string]map[string]bool `json:"revokedDevices,omitempty"`
}

type ownedForwardClaim struct {
	queuedMessage
	token *byte
}

type queueStore struct {
	mu                 sync.Mutex
	flushMu            sync.Mutex
	dispatchCancelMu   sync.Mutex
	dispatchCancels    map[context.Context]context.CancelFunc
	dispatchMu         sync.RWMutex
	path               string
	proxyURL           string
	activeAccountID    string
	activeSessionToken string
	httpClient         *http.Client
	httpConnectTimeout time.Duration
	state              queueFile
	admitted           map[string]string
	ownedForwardClaims map[string]*byte
}

type queueInitParams struct {
	Path           string `json:"path"`
	LegacySnapshot string `json:"legacySnapshot"`
	LegacyJournal  string `json:"legacyJournal"`
}
type setFriendsParams struct {
	AccountID string        `json:"accountId"`
	Friends   []friendRoute `json:"friends"`
}
type enqueueParams struct {
	SessionToken string `json:"sessionToken,omitempty"`
	AccountID    string `json:"accountId"`
	ID           string `json:"id"`
	FriendID     string `json:"friendId"`
	OnionAddress string `json:"onionAddress"`
	Payload      string `json:"payload"`
	// Raw payload admission is internal until the binary IPC method is integrated.
	PayloadFormat   string `json:"-"`
	InboxWriteToken string `json:"inboxWriteToken"`
	CreatedAt       int64  `json:"createdAt"`
	Immutable       bool   `json:"immutable,omitempty"`
}
type setProxyParams struct {
	ProxyURL string `json:"proxyUrl"`
}
type flushParams struct {
	AccountID        string `json:"accountId"`
	ConnectTimeoutMs int    `json:"connectTimeoutMs"`
	AckTimeoutMs     int    `json:"ackTimeoutMs"`
	DiagnoseID       string `json:"diagnoseId,omitempty"`
}

// Returned only to the caller that selected one in-memory queue ID. No ID,
// address, token, payload or raw network error is copied into this result.
type queueFlushDiagnostic struct {
	State             string `json:"state"`
	Attempts          int    `json:"attempts"`
	DueInMs           int64  `json:"dueInMs"`
	QueueAgeMs        int64  `json:"queueAgeMs"`
	RetryStartMs      int64  `json:"retryStartMs,omitempty"`
	RetryStarted      bool   `json:"retryStarted,omitempty"`
	DueLatenessMs     int64  `json:"dueLatenessMs,omitempty"`
	AttemptDurationMs int64  `json:"attemptDurationMs,omitempty"`
	PriorAttempts     int    `json:"priorAttempts,omitempty"`
	PriorNetworkMs    int64  `json:"priorNetworkMs,omitempty"`
	SocksDurationMs   int64  `json:"socksDurationMs,omitempty"`
	SocksStarted      bool   `json:"socksStarted,omitempty"`
	ConnectionReused  bool   `json:"connectionReused,omitempty"`
	NetworkStage      string `json:"networkStage,omitempty"`
	ErrorCode         string `json:"errorCode,omitempty"`
	HTTPStatus        int    `json:"httpStatus,omitempty"`
	NextDueInMs       int64  `json:"nextDueInMs,omitempty"`
	Delivered         bool   `json:"delivered,omitempty"`
}

type queueAttemptTrace struct {
	mu               sync.Mutex
	stage            string
	socksStarted     time.Time
	socksDuration    time.Duration
	httpStatus       int
	connectionReused bool
}

func (trace *queueAttemptTrace) mark(stage string) {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	trace.stage = stage
	if stage == "socks_connect" {
		trace.socksStarted = time.Now()
	}
	if stage == "http_request" && !trace.socksStarted.IsZero() {
		trace.socksDuration = time.Since(trace.socksStarted)
	}
}

func (trace *queueAttemptTrace) gotConn(reused bool) {
	trace.mark("http_request")
	trace.mu.Lock()
	trace.connectionReused = reused
	trace.mu.Unlock()
}

func (trace *queueAttemptTrace) snapshot() (string, int64, int, bool, bool) {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	duration := trace.socksDuration
	if duration == 0 && !trace.socksStarted.IsZero() {
		duration = time.Since(trace.socksStarted)
	}
	stage := trace.stage
	if stage == "" {
		stage = "unknown"
	}
	return stage, duration.Milliseconds(), trace.httpStatus, !trace.socksStarted.IsZero(), trace.connectionReused
}

type accountParams struct {
	AccountID    string `json:"accountId"`
	SessionToken string `json:"sessionToken,omitempty"`
}

const legacyAccountID = "legacy"

func normalizeAccountID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return "", fmt.Errorf("invalid_account_id")
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_' {
			continue
		}
		return "", fmt.Errorf("invalid_account_id")
	}
	return value, nil
}

func newID() string {
	bytes := make([]byte, 16)
	_, _ = rand.Read(bytes)
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	hexID := hex.EncodeToString(bytes)
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexID[:8], hexID[8:12], hexID[12:16], hexID[16:20], hexID[20:])
}

func normalizeOnion(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimPrefix(value, "http://")
	value = strings.TrimPrefix(value, "https://")
	if index := strings.IndexByte(value, '/'); index >= 0 {
		value = value[:index]
	}
	return value
}

func openQueueStore(path string, legacyPaths ...string) (*queueStore, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("invalid_queue_path")
	}
	store := &queueStore{
		path: path, activeAccountID: legacyAccountID,
		state: queueFile{Friends: []friendRoute{}, Messages: []queuedMessage{}},
	}
	raw, err := readQueueSnapshotFile(path)
	if os.IsNotExist(err) {
		raw, err = readQueueSnapshotFile(path + ".bak")
	}
	if err == nil {
		if store.state, err = decodeQueueSnapshot(raw); err != nil {
			return nil, fmt.Errorf("invalid_queue_file")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	} else if len(legacyPaths) >= 2 {
		if err = store.migrateLegacy(legacyPaths[0], legacyPaths[1]); err != nil {
			return nil, err
		}
	}
	changed := store.assignLegacyAccount()
	for index := range store.state.Messages {
		// A previous process cannot finish its request; current-session readmission still gates retry.
		if store.state.Messages[index].Status == "IN_FLIGHT" {
			store.state.Messages[index].Status = "PENDING"
			changed = true
		}
	}
	if changed {
		if err = store.persist(); err != nil {
			return nil, err
		}
	}
	return store, nil
}

func (q *queueStore) assignLegacyAccount() bool {
	changed := false
	for index := range q.state.Friends {
		if strings.TrimSpace(q.state.Friends[index].AccountID) == "" {
			q.state.Friends[index].AccountID = legacyAccountID
			changed = true
		}
	}
	for index := range q.state.Messages {
		if strings.TrimSpace(q.state.Messages[index].AccountID) == "" {
			q.state.Messages[index].AccountID = legacyAccountID
			changed = true
		}
		// No dispatch survives a worker restart; custody still requires current runtime readmission.
		if q.state.Messages[index].Status == "IN_FLIGHT" {
			q.state.Messages[index].Status = "PENDING"
			changed = true
		}
	}
	return changed
}

type legacyJournalEntry struct {
	Op        string                     `json:"op"`
	Queue     *queueFile                 `json:"queue"`
	Friends   []friendRoute              `json:"friends"`
	Message   *queuedMessage             `json:"message"`
	Friend    *friendRoute               `json:"friend"`
	IDs       []string                   `json:"ids"`
	Patch     map[string]json.RawMessage `json:"patch"`
	FriendID  string                     `json:"friendId"`
	UpdatedAt int64                      `json:"updatedAt"`
	LastError string                     `json:"lastError"`
}

func (q *queueStore) migrateLegacy(snapshotPath, journalPath string) error {
	if raw, err := os.ReadFile(snapshotPath); err == nil {
		_ = json.Unmarshal(raw, &q.state)
	}
	if raw, err := os.ReadFile(journalPath); err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(raw)))
		scanner.Buffer(make([]byte, 64*1024), 32*1024*1024)
		for scanner.Scan() {
			var entry legacyJournalEntry
			if json.Unmarshal(scanner.Bytes(), &entry) != nil {
				continue
			}
			q.applyLegacyEntry(entry)
		}
	}
	if len(q.state.Friends) > 0 || len(q.state.Messages) > 0 {
		for _, message := range q.state.Messages {
			if message.PayloadFormat != "" || strings.HasPrefix(message.ID, "owned-binary-v1:") {
				return fmt.Errorf("binary_payload_in_legacy_snapshot")
			}
		}
		return q.persist()
	}
	return nil
}

func (q *queueStore) applyLegacyEntry(entry legacyJournalEntry) {
	switch entry.Op {
	case "base":
		if entry.Queue != nil {
			q.state = *entry.Queue
		}
	case "replaceFriends":
		q.state.Friends = entry.Friends
	case "upsertMessage":
		if entry.Friend != nil {
			found := false
			for index := range q.state.Friends {
				if q.state.Friends[index].FriendID == entry.Friend.FriendID {
					q.state.Friends[index] = *entry.Friend
					found = true
				}
			}
			if !found {
				q.state.Friends = append(q.state.Friends, *entry.Friend)
			}
		}
		if entry.Message != nil {
			found := false
			for index := range q.state.Messages {
				if q.state.Messages[index].ID == entry.Message.ID {
					q.state.Messages[index] = *entry.Message
					found = true
				}
			}
			if !found {
				q.state.Messages = append(q.state.Messages, *entry.Message)
			}
		}
	case "patchMessages":
		ids := map[string]bool{}
		for _, id := range entry.IDs {
			ids[id] = true
		}
		for index := range q.state.Messages {
			if !ids[q.state.Messages[index].ID] {
				continue
			}
			if raw := entry.Patch["status"]; raw != nil {
				_ = json.Unmarshal(raw, &q.state.Messages[index].Status)
			}
			if raw := entry.Patch["updatedAt"]; raw != nil {
				_ = json.Unmarshal(raw, &q.state.Messages[index].UpdatedAt)
			}
			if raw := entry.Patch["deliveredAt"]; raw != nil {
				_ = json.Unmarshal(raw, &q.state.Messages[index].DeliveredAt)
			}
			if raw := entry.Patch["lastError"]; raw != nil {
				_ = json.Unmarshal(raw, &q.state.Messages[index].LastError)
			} else {
				q.state.Messages[index].LastError = ""
			}
		}
	case "resetFriend":
		for index := range q.state.Messages {
			if q.state.Messages[index].FriendID == entry.FriendID && q.state.Messages[index].Status == "IN_FLIGHT" {
				q.state.Messages[index].Status = "PENDING"
				q.state.Messages[index].UpdatedAt = entry.UpdatedAt
				q.state.Messages[index].LastError = entry.LastError
			}
		}
	}
}

func (q *queueStore) persist() error {
	if err := os.MkdirAll(filepath.Dir(q.path), 0o700); err != nil {
		return err
	}
	raw, err := encodeQueueSnapshot(q.state)
	if err != nil {
		return err
	}
	temp := q.path + ".tmp"
	if err = writeQueueSnapshotFile(temp, raw); err != nil {
		return err
	}
	defer os.Remove(temp)
	backup := q.path + ".bak"
	hadCurrent := false
	if _, statErr := os.Stat(q.path); statErr == nil {
		// A recovered backup is the only committed snapshot until publish succeeds.
		_ = os.Remove(backup)
		if err = os.Rename(q.path, backup); err != nil {
			return err
		}
		hadCurrent = true
	} else if !os.IsNotExist(statErr) {
		return statErr
	}
	if err = os.Rename(temp, q.path); err != nil {
		if hadCurrent {
			_ = os.Rename(backup, q.path)
		}
		return err
	}
	_ = os.Remove(backup)
	return nil
}

func (q *queueStore) setFriends(accountID string, friends []friendRoute) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	accountID, err := normalizeAccountID(accountID)
	if err != nil {
		return err
	}
	byID := make(map[string]friendRoute, len(friends))
	otherAccounts := make([]friendRoute, 0, len(q.state.Friends))
	for _, friend := range q.state.Friends {
		if friend.AccountID == accountID {
			byID[friend.FriendID] = friend
		} else {
			otherAccounts = append(otherAccounts, friend)
		}
	}
	for _, friend := range friends {
		friend.OnionAddress = normalizeOnion(friend.OnionAddress)
		if friend.FriendID == "" || !strings.HasSuffix(friend.OnionAddress, ".onion") {
			continue
		}
		friend.AccountID = accountID
		byID[friend.FriendID] = friend
	}
	q.state.Friends = otherAccounts
	for _, friend := range byID {
		q.state.Friends = append(q.state.Friends, friend)
	}
	sort.Slice(q.state.Friends, func(i, j int) bool {
		if q.state.Friends[i].AccountID == q.state.Friends[j].AccountID {
			return q.state.Friends[i].FriendID < q.state.Friends[j].FriendID
		}
		return q.state.Friends[i].AccountID < q.state.Friends[j].AccountID
	})
	return q.persist()
}

func (q *queueStore) enqueue(input enqueueParams) (admittedMessage queuedMessage, enqueueErr error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.enqueueLocked(input)
}

func (q *queueStore) enqueueLocked(input enqueueParams) (admittedMessage queuedMessage, enqueueErr error) {
	// Restored disk custody is not permission to dispatch in a new worker/account session.
	defer func() {
		if enqueueErr == nil && admittedMessage.AccountID != legacyAccountID && admittedMessage.Status == "PENDING" && admittedMessage.Payload == input.Payload {
			if q.admitted == nil {
				q.admitted = make(map[string]string)
			}
			digest := sha256.Sum256([]byte(admittedMessage.Payload))
			q.admitted[admittedMessage.AccountID+"\x00"+admittedMessage.ID] = hex.EncodeToString(digest[:])
		}
	}()
	if input.PayloadFormat != "" && input.PayloadFormat != binaryQueuePayloadFormat {
		return queuedMessage{}, fmt.Errorf("unsupported_queue_payload_format")
	}
	if input.PayloadFormat == "" && strings.HasPrefix(input.ID, "owned-binary-v1:") {
		return queuedMessage{}, fmt.Errorf("binary_queue_format_required")
	}
	if input.PayloadFormat == binaryQueuePayloadFormat && (!input.Immutable || len(input.Payload) == 0 ||
		len(input.Payload) > 2*1024*1024 || input.ID != ownedBinaryRetryID(input.Payload)) {
		return queuedMessage{}, fmt.Errorf("invalid_binary_queue_identity")
	}
	accountID, err := normalizeAccountID(input.AccountID)
	if err != nil {
		return queuedMessage{}, err
	}
	if q.activeSessionToken != "" && (q.activeAccountID != accountID || q.activeSessionToken != input.SessionToken) {
		return queuedMessage{}, fmt.Errorf("owner_session_changed")
	}
	if q.state.RevokedDevices[accountID][input.FriendID] {
		return queuedMessage{}, fmt.Errorf("device_authority_revoked")
	}
	onion := normalizeOnion(input.OnionAddress)
	if input.FriendID == "" || !strings.HasSuffix(onion, ".onion") || len(input.Payload) == 0 {
		return queuedMessage{}, fmt.Errorf("invalid_friend_onion_route")
	}
	if input.Immutable && input.ID == "" {
		return queuedMessage{}, fmt.Errorf("immutable_queue_id_required")
	}
	immutableDigest := ""
	retryDigest := ""
	if input.Immutable {
		digest := sha256.Sum256([]byte(input.Payload))
		immutableDigest = hex.EncodeToString(digest[:])
		if input.PayloadFormat == "" {
			retryDigest = transportRetryDigest(input.ID, input.Payload)
		}
	}
	now := time.Now().UnixMilli()
	if input.CreatedAt <= 0 {
		input.CreatedAt = now
	}
	if input.ID == "" {
		input.ID = newID()
	}
	for index, existing := range q.state.Messages {
		if existing.AccountID != accountID || existing.ID != input.ID {
			continue
		}
		if existing.PayloadFormat != input.PayloadFormat {
			return queuedMessage{}, fmt.Errorf("immutable_queue_format_conflict")
		}
		if existing.Status == "DELIVERED" && existing.LastError == "application-receipt" {
			return existing, nil
		}
		if existing.Status == "CANCELLED" && (existing.LastError == "application-cancelled" || existing.LastError == "session-superseded") {
			return queuedMessage{}, fmt.Errorf("application_cancelled")
		}
		if input.Immutable || existing.ImmutablePayloadDigest != "" {
			// A repeat handoff is an observation of the same durable owner, not a
			// manual retry command. Preserve due times and even terminal states.
			digest := sha256.Sum256([]byte(input.Payload))
			compatibleRetry := input.PayloadFormat == "" && existing.Status == "DELIVERED" && existing.TransportRetryDigest != "" && existing.TransportRetryDigest == transportRetryDigest(input.ID, input.Payload)
			if existing.ImmutablePayloadDigest == "" || existing.ImmutablePayloadDigest != hex.EncodeToString(digest[:]) && !compatibleRetry ||
				existing.FriendID != input.FriendID || existing.OnionAddress != onion || existing.InboxWriteToken != input.InboxWriteToken {
				return queuedMessage{}, fmt.Errorf("immutable_queue_conflict")
			}
			return existing, nil
		}
		if existing.Status != "DELIVERED" {
			existing.Status, existing.UpdatedAt, existing.LastError = "PENDING", now, ""
			existing.Attempts, existing.NextAttemptAt, existing.FailedAt = 0, now, 0
			q.state.Messages[index] = existing
			return existing, q.persist()
		}
		return existing, nil
	}
	message := queuedMessage{
		AccountID: accountID, ID: input.ID, FriendID: input.FriendID, OnionAddress: onion, Payload: input.Payload, PayloadFormat: input.PayloadFormat,
		InboxWriteToken:        input.InboxWriteToken,
		ImmutablePayloadDigest: immutableDigest,
		TransportRetryDigest:   retryDigest,
		Status:                 "PENDING", CreatedAt: input.CreatedAt, UpdatedAt: now, NextAttemptAt: now,
	}
	previousState := q.state
	if input.Immutable {
		// Keep rollback slices independent of append capacity and route updates.
		q.state.Messages = append([]queuedMessage(nil), q.state.Messages...)
		q.state.Friends = append([]friendRoute(nil), q.state.Friends...)
	}
	q.state.Messages = append(q.state.Messages, message)
	found := false
	for index, friend := range q.state.Friends {
		if friend.AccountID == accountID && friend.FriendID == input.FriendID {
			q.state.Friends[index].OnionAddress = onion
			found = true
		}
	}
	if !found {
		q.state.Friends = append(q.state.Friends, friendRoute{AccountID: accountID, FriendID: input.FriendID, OnionAddress: onion})
	}
	if err = q.persist(); err != nil {
		if input.Immutable {
			q.state = previousState
			return queuedMessage{}, err
		}
		return message, err
	}
	return message, nil
}

func (q *queueStore) list(accountID string) []queuedMessage {
	q.mu.Lock()
	defer q.mu.Unlock()
	result := []queuedMessage{}
	for _, message := range q.state.Messages {
		if message.AccountID == accountID {
			result = append(result, message)
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].CreatedAt < result[j].CreatedAt })
	return result
}

func (q *queueStore) removeAccount(accountID string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	accountID, err := normalizeAccountID(accountID)
	if err != nil {
		return err
	}
	before := q.state
	friends := make([]friendRoute, 0, len(before.Friends))
	for _, friend := range before.Friends {
		if friend.AccountID != accountID {
			friends = append(friends, friend)
		}
	}
	messages := make([]queuedMessage, 0, len(before.Messages))
	for _, message := range before.Messages {
		if message.AccountID != accountID {
			messages = append(messages, message)
		}
	}
	revoked := make(map[string]map[string]bool, len(before.RevokedDevices))
	for owner, devices := range before.RevokedDevices {
		if owner != accountID {
			revoked[owner] = devices
		}
	}
	q.state = queueFile{Friends: friends, Messages: messages, RevokedDevices: revoked}
	if err := q.persist(); err != nil {
		q.state = before
		return err
	}
	for key := range q.admitted {
		if strings.HasPrefix(key, accountID+"\x00") {
			delete(q.admitted, key)
		}
	}
	for key := range q.ownedForwardClaims {
		if strings.HasPrefix(key, accountID+"\x00") {
			delete(q.ownedForwardClaims, key)
		}
	}
	return nil
}

func (q *queueStore) clearPending(accountID string) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	accountID, err := normalizeAccountID(accountID)
	if err != nil {
		return 0, err
	}
	removed := 0
	previous := q.state.Messages
	messages := make([]queuedMessage, 0, len(previous))
	for _, message := range q.state.Messages {
		if message.AccountID == accountID && message.Status != "DELIVERED" &&
			!(message.Status == "CANCELLED" && (message.LastError == "application-cancelled" || message.LastError == "session-superseded")) {
			removed++
			continue
		}
		messages = append(messages, message)
	}
	if removed == 0 {
		return 0, nil
	}
	q.state.Messages = messages
	if err := q.persist(); err != nil {
		q.state.Messages = previous
		return 0, err
	}
	for _, message := range previous {
		if message.AccountID == accountID && message.Status != "DELIVERED" &&
			!(message.Status == "CANCELLED" && (message.LastError == "application-cancelled" || message.LastError == "session-superseded")) {
			delete(q.ownedForwardClaims, message.AccountID+"\x00"+message.ID)
		}
	}
	return removed, nil
}

func (q *queueStore) setProxy(value string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.proxyURL != strings.TrimSpace(value) && q.httpClient != nil {
		q.httpClient.CloseIdleConnections()
		q.httpClient = nil
	}
	q.proxyURL = strings.TrimSpace(value)
}

func (q *queueStore) setActiveAccount(accountID string, sessionToken ...string) error {
	accountID, err := normalizeAccountID(accountID)
	if err != nil {
		return err
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	token := ""
	if len(sessionToken) > 0 {
		token = sessionToken[0]
	}
	if token == "" || q.activeAccountID != accountID || q.activeSessionToken != token {
		q.admitted = nil
		if q.httpClient != nil {
			q.httpClient.CloseIdleConnections()
			q.httpClient = nil
		}
	}
	q.activeAccountID, q.activeSessionToken = accountID, token
	return nil
}

func (q *queueStore) activeAccount() string {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.activeAccountID
}

func (q *queueStore) currentSession(accountID, token string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.activeSessionToken == "" || q.activeAccountID == accountID && q.activeSessionToken == token
}

type socksProxyConfig struct {
	address  string
	username string
	password string
	hasAuth  bool
}

func parseProxy(proxyURL string) (socksProxyConfig, error) {
	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return socksProxyConfig{}, err
	}
	if parsed.Scheme != "socks5" && parsed.Scheme != "socks5h" {
		return socksProxyConfig{}, fmt.Errorf("unsupported_socks_protocol")
	}
	if parsed.Hostname() == "" || parsed.Port() == "" {
		return socksProxyConfig{}, fmt.Errorf("invalid_socks_proxy")
	}
	config := socksProxyConfig{address: net.JoinHostPort(parsed.Hostname(), parsed.Port())}
	if parsed.User != nil {
		config.username = parsed.User.Username()
		config.password, config.hasAuth = parsed.User.Password()
		if config.username == "" || !config.hasAuth || config.password == "" || len(config.username) > 255 || len(config.password) > 255 {
			return socksProxyConfig{}, fmt.Errorf("invalid_socks_auth")
		}
	}
	return config, nil
}

func dialSOCKS(proxyURL, target string, targetPort int, timeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return dialSOCKSContext(ctx, proxyURL, target, targetPort, timeout)
}

// C Tor ends a timed-out stream on a rendezvous circuit but keeps the circuit (connection_edge.c
// connection_ap_expire_beginning), so later streams to a restarted onion service reuse the dead circuit.
// A new SOCKS isolation key (IsolateSOCKSAuth, Tor's default) makes Tor build a fresh rendezvous instead.
type onionIsolation struct{ epochs sync.Map } // onion host -> *atomic.Uint64

func (o *onionIsolation) epoch(host string) *atomic.Uint64 {
	epoch, _ := o.epochs.LoadOrStore(strings.ToLower(host), new(atomic.Uint64))
	return epoch.(*atomic.Uint64)
}

// proxyFor keeps the unauthenticated proxy until a request to this onion host has timed out.
func (o *onionIsolation) proxyFor(proxyURL, host string) string {
	parsed, err := url.Parse(proxyURL)
	if err != nil || parsed.User != nil || !strings.HasSuffix(strings.ToLower(host), ".onion") {
		return proxyURL
	}
	if epoch := o.epoch(host).Load(); epoch > 0 {
		parsed.User = url.UserPassword("nkc-rend", strconv.FormatUint(epoch, 10))
		return parsed.String()
	}
	return proxyURL
}

// isolationRoundTripper rotates an onion host's isolation key after a request to it timed out.
type isolationRoundTripper struct {
	transport *http.Transport
	isolation *onionIsolation
}

func (r isolationRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := r.transport.RoundTrip(request)
	if err != nil && strings.HasSuffix(strings.ToLower(request.URL.Hostname()), ".onion") && normalizeForwardError(err) == "upstream_response_timeout" {
		r.isolation.epoch(request.URL.Hostname()).Add(1)
		r.transport.CloseIdleConnections()
	}
	return response, err
}

func (r isolationRoundTripper) CloseIdleConnections() { r.transport.CloseIdleConnections() }

func dialSOCKSContext(ctx context.Context, proxyURL, target string, targetPort int, timeout time.Duration) (net.Conn, error) {
	observeProbeStage(ctx, "proxy_connect")
	proxy, err := parseProxy(proxyURL)
	if err != nil {
		return nil, err
	}
	conn, err := (&net.Dialer{Timeout: timeout}).DialContext(ctx, "tcp", proxy.address)
	if err != nil {
		return nil, fmt.Errorf("proxy_connect:%w", err)
	}
	// DialContext no longer owns the socket while SOCKS is still awaiting its reply.
	stopCancellation := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopCancellation()
	fail := func(err error) (net.Conn, error) { _ = conn.Close(); return nil, err }
	deadline := time.Now().Add(timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	_ = conn.SetDeadline(deadline)
	observeProbeStage(ctx, "socks_handshake")
	method := byte(0)
	if proxy.hasAuth {
		method = 2
	}
	if _, err = conn.Write([]byte{5, 1, method}); err != nil {
		return fail(fmt.Errorf("socks_handshake:%w", err))
	}
	reply := make([]byte, 2)
	if _, err = io.ReadFull(conn, reply); err != nil {
		return fail(fmt.Errorf("socks_handshake:%w", err))
	}
	if reply[0] != 5 || reply[1] != method {
		return fail(fmt.Errorf("socks_auth_failed"))
	}
	if proxy.hasAuth {
		authRequest := []byte{1, byte(len(proxy.username))}
		authRequest = append(authRequest, []byte(proxy.username)...)
		authRequest = append(authRequest, byte(len(proxy.password)))
		authRequest = append(authRequest, []byte(proxy.password)...)
		if _, err = conn.Write(authRequest); err != nil {
			return fail(fmt.Errorf("socks_auth:%w", err))
		}
		authReply := make([]byte, 2)
		if _, err = io.ReadFull(conn, authReply); err != nil {
			return fail(fmt.Errorf("socks_auth:%w", err))
		}
		if authReply[0] != 1 || authReply[1] != 0 {
			return fail(fmt.Errorf("socks_auth_failed"))
		}
	}
	host := []byte(normalizeOnion(target))
	observeProbeStage(ctx, "socks_connect")
	if len(host) == 0 || len(host) > 255 {
		return fail(fmt.Errorf("target_host_too_long"))
	}
	request := append([]byte{5, 1, 0, 3, byte(len(host))}, host...)
	port := make([]byte, 2)
	binary.BigEndian.PutUint16(port, uint16(targetPort))
	request = append(request, port...)
	if _, err = conn.Write(request); err != nil {
		return fail(fmt.Errorf("socks_connect:%w", err))
	}
	head := make([]byte, 4)
	if _, err = io.ReadFull(conn, head); err != nil {
		return fail(fmt.Errorf("socks_connect:%w", err))
	}
	if head[0] != 5 || head[1] != 0 {
		return fail(fmt.Errorf("socks_reply_%s", socksReplyName(head[1])))
	}
	addressBytes := 0
	switch head[3] {
	case 1:
		addressBytes = 4
	case 4:
		addressBytes = 16
	case 3:
		length := make([]byte, 1)
		if _, err = io.ReadFull(conn, length); err != nil {
			return fail(err)
		}
		addressBytes = int(length[0])
	default:
		return fail(fmt.Errorf("socks_connect_failed"))
	}
	if _, err = io.ReadFull(conn, make([]byte, addressBytes+2)); err != nil {
		return fail(err)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

func socksReplyName(code byte) string {
	switch code {
	case 1:
		return "general_failure"
	case 2:
		return "ruleset_denied"
	case 3:
		return "network_unreachable"
	case 4:
		return "host_unreachable"
	case 5:
		return "connection_refused"
	case 6:
		return "ttl_expired"
	case 7:
		return "command_unsupported"
	case 8:
		return "address_unsupported"
	default:
		return "unknown"
	}
}

func (q *queueStore) pendingForFriend(accountID, friendID string, now int64) []queuedMessage {
	result := []queuedMessage{}
	for _, message := range q.state.Messages {
		if message.AccountID == accountID && message.FriendID == friendID && message.Status == "PENDING" && message.NextAttemptAt <= now && q.isAdmitted(message) {
			result = append(result, message)
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].CreatedAt < result[j].CreatedAt })
	return result
}

func (q *queueStore) isAdmitted(message queuedMessage) bool {
	if message.AccountID == legacyAccountID {
		return true
	}
	digest := sha256.Sum256([]byte(message.Payload))
	return q.admitted[message.AccountID+"\x00"+message.ID] == hex.EncodeToString(digest[:])
}

func queueFailurePolicy(err error, attempts int, now int64) (string, string, int64) {
	code := normalizeForwardError(err)
	text := strings.ToLower(err.Error())
	permanent := strings.Contains(text, "invalid_") ||
		strings.Contains(text, "unsupported_") ||
		strings.Contains(text, "socks_auth_failed") ||
		strings.Contains(text, "response_too_large") ||
		(strings.HasPrefix(text, "ingest_failed:4") && !strings.HasPrefix(text, "ingest_failed:429"))
	if permanent || attempts >= 15 {
		return "FAILED", code, 0
	}
	base, capDelay := int64(3_000), int64(120_000)
	switch code {
	case "onion_service_refused":
		base, capDelay = 1_000, 30_000
	case "proxy_unreachable", "proxy_connect_timeout":
		base, capDelay = 2_000, 60_000
	case "onion_descriptor_unavailable":
		base, capDelay = 5_000, 120_000
	}
	exponent := min(max(attempts-1, 0), 6)
	delay := base * int64(1<<exponent)
	if delay > capDelay {
		delay = capDelay
	}
	return "PENDING", code, now + delay
}

// Reuse terminal rows to fence a late forwarding failure, including one that
// arrives after the receipt but before any native retry was admitted.
func (q *queueStore) confirmApplication(accountID, id string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	accountID, err := normalizeAccountID(accountID)
	if err != nil || accountID == legacyAccountID || !(ownedRetryPattern.MatchString(id) || binaryOwnedRetryPattern.MatchString(id)) {
		return fmt.Errorf("invalid_owned_retry")
	}
	before := append([]queuedMessage(nil), q.state.Messages...)
	now := time.Now().UnixMilli()
	index := -1
	for i, message := range q.state.Messages {
		if message.AccountID == accountID && message.ID == id {
			if message.Status == "CANCELLED" && message.LastError != "session-superseded" {
				return fmt.Errorf("device_authority_revoked")
			}
			index = i
			break
		}
	}
	if index < 0 {
		q.state.Messages = append(q.state.Messages, queuedMessage{AccountID: accountID, ID: id, CreatedAt: now, PayloadFormat: payloadFormatForOwnedID(id)})
		index = len(q.state.Messages) - 1
	}
	message := &q.state.Messages[index]
	message.Status, message.Payload, message.LastError = "DELIVERED", "", "application-receipt"
	message.NextAttemptAt, message.DeliveredAt, message.UpdatedAt = 0, now, now
	if err := q.persist(); err != nil {
		q.state.Messages = before
		return err
	}
	return nil
}

func (q *queueStore) cancelApplication(accountID, id string) error {
	return q.stopApplicationRetry(accountID, id, "application-cancelled")
}

func (q *queueStore) supersedeApplication(accountID, id string) error {
	return q.stopApplicationRetry(accountID, id, "session-superseded")
}

func (q *queueStore) stopApplicationRetry(accountID, id, reason string) error {
	q.lockDispatch()
	defer q.dispatchMu.Unlock()
	q.mu.Lock()
	defer q.mu.Unlock()
	accountID, err := normalizeAccountID(accountID)
	if err != nil || accountID == legacyAccountID || !(ownedRetryPattern.MatchString(id) || binaryOwnedRetryPattern.MatchString(id)) {
		return fmt.Errorf("invalid_owned_retry")
	}
	before := append([]queuedMessage(nil), q.state.Messages...)
	now, index := time.Now().UnixMilli(), -1
	for i, message := range q.state.Messages {
		if message.AccountID == accountID && message.ID == id {
			if message.Status == "DELIVERED" && message.LastError == "application-receipt" {
				return nil
			}
			// Supersession never weakens a source cancellation or a device revocation.
			if message.Status == "CANCELLED" && reason == "session-superseded" {
				return nil
			}
			index = i
			break
		}
	}
	if index < 0 {
		q.state.Messages = append(q.state.Messages, queuedMessage{AccountID: accountID, ID: id, CreatedAt: now, PayloadFormat: payloadFormatForOwnedID(id)})
		index = len(q.state.Messages) - 1
	}
	message := &q.state.Messages[index]
	message.Status, message.Payload, message.LastError = "CANCELLED", "", reason
	message.NextAttemptAt, message.UpdatedAt = 0, now
	if err := q.persist(); err != nil {
		q.state.Messages = before
		return err
	}
	return nil
}

func (q *queueStore) applicationCancelled(accountID, id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, message := range q.state.Messages {
		if message.AccountID == accountID && message.ID == id {
			return message.Status == "CANCELLED" && (message.LastError == "application-cancelled" || message.LastError == "session-superseded")
		}
	}
	return false
}

func (q *queueStore) matchingActiveRetry(accountID, id, friendID, onion, payload string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, message := range q.state.Messages {
		if message.AccountID == accountID && message.ID == id {
			return message.Status == "IN_FLIGHT" && message.ImmutablePayloadDigest != "" &&
				message.FriendID == friendID && normalizeRouteTarget("tor", message.OnionAddress) == onion && message.Payload == payload && q.isAdmitted(message)
		}
	}
	return false
}

// Only fresh owner retries of transport-accepted packets may vary the reply timestamp.
func transportRetryDigest(id, envelope string) string {
	if len(envelope) > queueRequestFrameLimit {
		return ""
	}
	decode := func(value string) ([]byte, error) {
		return base64.RawURLEncoding.DecodeString(strings.TrimRight(value, "="))
	}
	raw, err := decode(envelope)
	if err != nil {
		return ""
	}
	var packet map[string]json.RawMessage
	var ciphertext []byte
	if bytes.HasPrefix(raw, []byte{'N', 'K', 'C', 'P', 1}) {
		if len(raw) < 9 {
			return ""
		}
		headerLength := binary.BigEndian.Uint32(raw[5:9])
		if headerLength > 64*1024 || uint64(headerLength) > uint64(len(raw)-9) {
			return ""
		}
		headerSize := int(headerLength)
		if !utf8.Valid(raw[9:9+headerSize]) || json.Unmarshal(raw[9:9+headerSize], &packet) != nil {
			return ""
		}
		if _, exists := packet["payload"]; exists {
			return ""
		}
		ciphertext = raw[9+headerSize:]
	} else {
		if !utf8.Valid(raw) || json.Unmarshal(raw, &packet) != nil {
			return ""
		}
		var text string
		if json.Unmarshal(packet["payload"], &text) == nil {
			ciphertext = []byte(text)
		} else {
			var encoded map[string]string
			if json.Unmarshal(packet["payload"], &encoded) != nil || len(encoded) != 1 {
				return ""
			}
			ciphertext, err = decode(encoded["b64"])
			if err != nil {
				return ""
			}
		}
	}
	var packetID string
	if packet == nil || json.Unmarshal(packet["id"], &packetID) != nil || packetID == "" {
		return ""
	}
	digest := sha256.New()
	digest.Write([]byte(packetID + "\x00"))
	digest.Write(ciphertext)
	if "owned:"+hex.EncodeToString(digest.Sum(nil)) != id {
		return ""
	}
	if reply, exists := packet["replyRoute"]; exists {
		var route map[string]json.RawMessage
		var timestamp float64
		if json.Unmarshal(reply, &route) != nil || string(route["sentAt"]) == "null" || json.Unmarshal(route["sentAt"], &timestamp) != nil {
			return ""
		}
		route["sentAt"] = json.RawMessage("0")
		packet["replyRoute"], _ = json.Marshal(route)
	}
	packet["payload"], _ = json.Marshal(base64.RawURLEncoding.EncodeToString(ciphertext))
	canonical, err := json.Marshal(packet)
	if err != nil {
		return ""
	}
	fingerprint := sha256.Sum256(canonical)
	return hex.EncodeToString(fingerprint[:])
}

func (q *queueStore) claimOwnedForward(input enqueueParams) (ownedForwardClaim, bool, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	message, err := q.enqueueLocked(input)
	if err != nil {
		return ownedForwardClaim{queuedMessage: message}, false, err
	}
	if message.Status == "IN_FLIGHT" || message.LastError == "application-receipt" || message.Status == "FAILED" || message.Status == "CANCELLED" {
		return ownedForwardClaim{queuedMessage: message}, false, nil
	}
	before := append([]queuedMessage(nil), q.state.Messages...)
	// A transport ACK is not an application receipt; an explicit owner retry may restore its exact ciphertext.
	if message.Status == "DELIVERED" {
		for index := range q.state.Messages {
			if q.state.Messages[index].AccountID == message.AccountID && q.state.Messages[index].ID == message.ID {
				q.state.Messages[index].Payload = input.Payload
				digest := sha256.Sum256([]byte(input.Payload))
				q.state.Messages[index].ImmutablePayloadDigest = hex.EncodeToString(digest[:])
				message.ImmutablePayloadDigest = q.state.Messages[index].ImmutablePayloadDigest
				q.state.Messages[index].Status = "PENDING"
				break
			}
		}
	}
	if err := q.patchStatus(message.AccountID, map[string]bool{message.ID: true}, "IN_FLIGHT", ""); err != nil {
		q.state.Messages = before
		return ownedForwardClaim{queuedMessage: message}, false, err
	}
	if q.admitted == nil {
		q.admitted = make(map[string]string)
	}
	q.admitted[message.AccountID+"\x00"+message.ID] = message.ImmutablePayloadDigest
	if q.ownedForwardClaims == nil {
		q.ownedForwardClaims = make(map[string]*byte)
	}
	token := new(byte)
	q.ownedForwardClaims[message.AccountID+"\x00"+message.ID] = token
	return ownedForwardClaim{queuedMessage: message, token: token}, true, nil
}

func (q *queueStore) applicationConfirmed(accountID, id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, message := range q.state.Messages {
		if message.AccountID == accountID && message.ID == id {
			return message.Status == "DELIVERED" && message.LastError == "application-receipt"
		}
	}
	return false
}

// Reuse the durable queue to fence new handoffs and late failures after unlink.
// Existing in-flight network work settles before this operation acknowledges cancellation.
func (q *queueStore) revokeDevice(accountID, deviceID string) error {
	q.lockDispatch()
	defer q.dispatchMu.Unlock()
	q.mu.Lock()
	defer q.mu.Unlock()
	accountID, err := normalizeAccountID(accountID)
	if err != nil {
		return err
	}
	if deviceID == "" || len(deviceID) > 256 {
		return fmt.Errorf("invalid_device_id")
	}
	if q.state.RevokedDevices[accountID][deviceID] {
		return nil
	}
	previous := q.state
	revoked := make(map[string]map[string]bool)
	for owner, devices := range q.state.RevokedDevices {
		revoked[owner] = devices
	}
	devices := make(map[string]bool)
	for id, value := range revoked[accountID] {
		devices[id] = value
	}
	devices[deviceID] = true
	revoked[accountID] = devices
	q.state.RevokedDevices = revoked
	q.state.Messages = append([]queuedMessage(nil), q.state.Messages...)
	for index := range q.state.Messages {
		message := &q.state.Messages[index]
		if message.AccountID == accountID && message.FriendID == deviceID && message.Status != "DELIVERED" &&
			!(message.Status == "CANCELLED" && message.LastError == "application-cancelled") {
			message.Status, message.Payload, message.LastError = "CANCELLED", "", "device-revoked"
			message.NextAttemptAt, message.UpdatedAt = 0, time.Now().UnixMilli()
		}
	}
	if err := q.persist(); err != nil {
		q.state = previous
		return err
	}
	return nil
}

func (q *queueStore) deviceRevoked(accountID, deviceID string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.state.RevokedDevices[accountID][deviceID]
}

func (q *queueStore) patchFailure(accountID, id string, failure error) error {
	before := append([]queuedMessage(nil), q.state.Messages...)
	now := time.Now().UnixMilli()
	for index := range q.state.Messages {
		message := &q.state.Messages[index]
		if message.AccountID != accountID || message.ID != id || message.Status == "DELIVERED" || message.Status == "CANCELLED" {
			continue
		}
		message.Attempts++
		message.Status, message.LastError, message.NextAttemptAt = queueFailurePolicy(failure, message.Attempts, now)
		message.UpdatedAt = now
		if message.Status == "FAILED" {
			message.FailedAt = now
		}
		break
	}
	if err := q.persist(); err != nil {
		q.state.Messages = before
		return err
	}
	return nil
}

func (q *queueStore) patchStatus(accountID string, ids map[string]bool, status, lastError string) error {
	before := append([]queuedMessage(nil), q.state.Messages...)
	now := time.Now().UnixMilli()
	for index := range q.state.Messages {
		if q.state.Messages[index].AccountID != accountID || !ids[q.state.Messages[index].ID] || q.state.Messages[index].Status == "DELIVERED" || q.state.Messages[index].Status == "CANCELLED" {
			continue
		}
		q.state.Messages[index].Status = status
		q.state.Messages[index].UpdatedAt = now
		q.state.Messages[index].LastError = lastError
		if status == "DELIVERED" {
			q.state.Messages[index].NextAttemptAt = 0
			q.state.Messages[index].LastError = ""
			q.state.Messages[index].DeliveredAt = now
			// Delivery receipts retain metadata; the encrypted payload is no longer
			// needed for retry and should not be rewritten on every later update.
			q.state.Messages[index].Payload = ""
		}
	}
	if err := q.persist(); err != nil {
		q.state.Messages = before
		return err
	}
	return nil
}

func createOnionHTTPClient(proxyURL string, connectTimeout time.Duration) *http.Client {
	transport := &http.Transport{
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 2,
		IdleConnTimeout:     65 * time.Second,
		DisableCompression:  true,
	}
	isolation := &onionIsolation{}
	transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
		host, portText, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		port, err := strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return nil, fmt.Errorf("invalid_target_port")
		}
		return dialSOCKSContext(ctx, isolation.proxyFor(proxyURL, host), host, port, connectTimeout)
	}
	return &http.Client{
		Transport: isolationRoundTripper{transport, isolation},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func postIngest(client *http.Client, message queuedMessage, timeout time.Duration) error {
	return postIngestTraced(context.Background(), client, message, timeout, nil)
}

func postIngestTraced(parent context.Context, client *http.Client, message queuedMessage, timeout time.Duration, trace *queueAttemptTrace) error {
	var body []byte
	var err error
	headers := map[string]string{"Content-Type": "application/json"}
	if message.PayloadFormat != "" {
		if message.PayloadFormat != binaryQueuePayloadFormat || message.ID != ownedBinaryRetryID(message.Payload) || message.InboxWriteToken == "" {
			return fmt.Errorf("invalid_binary_ingest")
		}
		body = []byte(message.Payload)
		if _, err := binaryPacketID(body); err != nil {
			return err
		}
		headers = binaryIngestHeaders(message.ID, message.FriendID, message.InboxWriteToken)
	} else {
		body, err = json.Marshal(map[string]any{
			"id":              message.ID,
			"toDeviceId":      message.FriendID,
			"envelope":        message.Payload,
			"inboxWriteToken": message.InboxWriteToken,
		})
	}
	if err != nil {
		return err
	}
	if len(body) > queueRequestFrameLimit {
		return fmt.Errorf("frame_too_large")
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	if trace != nil {
		trace.mark("connection")
		ctx = context.WithValue(ctx, probeStageContextKey{}, func(stage string) { trace.mark(stage) })
		ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
			GotConn: func(info httptrace.GotConnInfo) { trace.gotConn(info.Reused) },
			WroteRequest: func(info httptrace.WroteRequestInfo) {
				if info.Err == nil {
					trace.mark("http_response")
				}
			},
			GotFirstResponseByte: func() { trace.mark("http_body") },
		})
	}
	endpoint := "http://" + message.OnionAddress + "/onion/ingest"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	request.Header.Set("Cache-Control", "no-store")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	if trace != nil {
		trace.mu.Lock()
		trace.httpStatus = response.StatusCode
		trace.mu.Unlock()
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, queueResponseFrameLimit+1))
	if err != nil {
		return err
	}
	if len(raw) > queueResponseFrameLimit {
		return fmt.Errorf("response_too_large")
	}
	return validateIngestAck(raw, response.StatusCode, message.ID)
}

func validateIngestAck(raw []byte, status int, messageID string) error {
	var ack struct {
		OK        bool   `json:"ok"`
		MessageID string `json:"msgId"`
	}
	if json.Unmarshal(raw, &ack) != nil || status != http.StatusOK || !ack.OK {
		return fmt.Errorf("ingest_failed:%d", status)
	}
	if ack.MessageID != messageID {
		return fmt.Errorf("ingest_ack_mismatch")
	}
	return nil
}

func (q *queueStore) beginDispatch() (context.Context, func()) {
	q.dispatchCancelMu.Lock()
	defer q.dispatchCancelMu.Unlock()
	q.dispatchMu.RLock()
	ctx, cancel := context.WithCancel(context.Background())
	if q.dispatchCancels == nil {
		q.dispatchCancels = make(map[context.Context]context.CancelFunc)
	}
	q.dispatchCancels[ctx] = cancel
	return ctx, func() {
		q.dispatchMu.RUnlock()
		q.dispatchCancelMu.Lock()
		delete(q.dispatchCancels, ctx)
		cancel()
		q.dispatchCancelMu.Unlock()
	}
}

// The existing fence is global: interrupt every holder, then wait for their durable settlement.
func (q *queueStore) lockDispatch() {
	q.dispatchCancelMu.Lock()
	defer q.dispatchCancelMu.Unlock()
	for _, cancel := range q.dispatchCancels {
		cancel()
	}
	q.dispatchMu.Lock()
}

func (q *queueStore) flush(params flushParams) (any, error) {
	var diagnostic *queueFlushDiagnostic
	if params.DiagnoseID != "" && len(params.DiagnoseID) <= 128 {
		diagnostic = &queueFlushDiagnostic{State: "not_observed"}
	}
	result := func(delivered int) any {
		if diagnostic == nil {
			return map[string]int{"delivered": delivered}
		}
		return map[string]any{"delivered": delivered, "diagnostic": diagnostic}
	}
	if !q.flushMu.TryLock() {
		if diagnostic != nil {
			diagnostic.State = "flush_busy"
		}
		return result(0), nil
	}
	defer q.flushMu.Unlock()
	ctx, finish := q.beginDispatch()
	defer finish()
	accountID, err := normalizeAccountID(params.AccountID)
	if err != nil {
		return nil, err
	}
	q.mu.Lock()
	proxyURL := q.proxyURL
	activeAccountID := q.activeAccountID
	friends := append([]friendRoute(nil), q.state.Friends...)
	if diagnostic != nil {
		for _, message := range q.state.Messages {
			if message.AccountID == accountID && message.ID == params.DiagnoseID {
				diagnostic.State = strings.ToLower(message.Status)
				diagnostic.Attempts = message.Attempts
				diagnostic.DueInMs = max(0, message.NextAttemptAt-time.Now().UnixMilli())
				diagnostic.QueueAgeMs = max(0, time.Now().UnixMilli()-message.CreatedAt)
				break
			}
		}
	}
	q.mu.Unlock()
	if proxyURL == "" {
		if diagnostic != nil && diagnostic.State == "pending" {
			diagnostic.State = "proxy_unavailable"
		}
		return result(0), nil
	}
	connectTimeout := time.Duration(params.ConnectTimeoutMs) * time.Millisecond
	ackTimeout := time.Duration(params.AckTimeoutMs) * time.Millisecond
	if connectTimeout <= 0 {
		connectTimeout = 8 * time.Second
	}
	if ackTimeout <= 0 {
		ackTimeout = 10 * time.Second
	}
	delivered := 0
	flushStarted := time.Now()
	now := flushStarted.UnixMilli()
	deadline := time.Now().Add(60 * time.Second)
	q.mu.Lock()
	if q.proxyURL != proxyURL || q.activeAccountID != activeAccountID {
		q.mu.Unlock()
		return result(0), nil
	}
	if q.httpClient == nil || q.httpConnectTimeout != connectTimeout {
		if q.httpClient != nil {
			q.httpClient.CloseIdleConnections()
		}
		q.httpClient = createOnionHTTPClient(proxyURL, connectTimeout)
		q.httpConnectTimeout = connectTimeout
	}
	client := q.httpClient
	q.mu.Unlock()
	for _, friend := range friends {
		if friend.AccountID != accountID {
			continue
		}
		q.mu.Lock()
		pending := q.pendingForFriend(accountID, friend.FriendID, now)
		q.mu.Unlock()
		if len(pending) == 0 {
			continue
		}
		for _, message := range pending {
			if ctx.Err() != nil || time.Now().After(deadline) {
				return result(delivered), nil
			}
			q.mu.Lock()
			if q.proxyURL != proxyURL || q.activeAccountID != activeAccountID {
				q.mu.Unlock()
				return result(delivered), nil
			}
			// Account deletion or queue clearing can happen between requests.
			present := false
			for _, current := range q.state.Messages {
				if current.AccountID == accountID && current.ID == message.ID && current.Status == "PENDING" && q.isAdmitted(current) {
					message = current
					present = true
					break
				}
			}
			if !present || q.ownedForwardClaims[accountID+"\x00"+message.ID] != nil {
				q.mu.Unlock()
				continue
			}
			ids := map[string]bool{message.ID: true}
			if err := q.patchStatus(accountID, ids, "IN_FLIGHT", ""); err != nil {
				q.mu.Unlock()
				return nil, err
			}
			if q.ownedForwardClaims == nil {
				q.ownedForwardClaims = make(map[string]*byte)
			}
			claimKey := accountID + "\x00" + message.ID
			claimToken := new(byte)
			q.ownedForwardClaims[claimKey] = claimToken
			q.mu.Unlock()
			var attemptTrace *queueAttemptTrace
			if diagnostic != nil && message.ID == params.DiagnoseID {
				attemptTrace = &queueAttemptTrace{}
				diagnostic.State = "retry_started"
				diagnostic.RetryStarted = true
				diagnostic.RetryStartMs = time.Since(flushStarted).Milliseconds()
				diagnostic.DueLatenessMs = max(0, time.Now().UnixMilli()-message.NextAttemptAt)
			}
			attemptStarted := time.Now()
			sendErr := postIngestTraced(ctx, client, message, min(ackTimeout, time.Until(deadline)), attemptTrace)
			if diagnostic != nil && !diagnostic.RetryStarted && attemptTrace == nil {
				diagnostic.PriorAttempts++
				diagnostic.PriorNetworkMs += time.Since(attemptStarted).Milliseconds()
			}
			if attemptTrace != nil {
				diagnostic.AttemptDurationMs = time.Since(attemptStarted).Milliseconds()
				diagnostic.NetworkStage, diagnostic.SocksDurationMs, diagnostic.HTTPStatus, diagnostic.SocksStarted, diagnostic.ConnectionReused = attemptTrace.snapshot()
				if sendErr != nil {
					diagnostic.ErrorCode = normalizeForwardError(sendErr)
				}
			}
			q.mu.Lock()
			if q.ownedForwardClaims[claimKey] != claimToken {
				q.mu.Unlock()
				if attemptTrace != nil {
					diagnostic.State = "superseded"
				}
				continue
			}
			delete(q.ownedForwardClaims, claimKey)
			if sendErr != nil {
				persistErr := q.patchFailure(accountID, message.ID, sendErr)
				if attemptTrace != nil {
					for _, current := range q.state.Messages {
						if current.AccountID == accountID && current.ID == message.ID {
							diagnostic.State = strings.ToLower(current.Status)
							diagnostic.Attempts = current.Attempts
							diagnostic.NextDueInMs = max(0, current.NextAttemptAt-time.Now().UnixMilli())
							break
						}
					}
				}
				q.mu.Unlock()
				if persistErr != nil {
					return nil, persistErr
				}
				// An HTTP rejection can be specific to this message. A network
				// outage affects the entire peer: defer its remaining backlog.
				if !strings.HasPrefix(sendErr.Error(), "ingest_failed:") {
					break
				}
				continue
			}
			persistErr := q.patchStatus(accountID, ids, "DELIVERED", "")
			q.mu.Unlock()
			if persistErr != nil {
				return nil, persistErr
			}
			if attemptTrace != nil {
				diagnostic.State = "delivered"
				diagnostic.Delivered = true
			}
			delivered++
		}
	}
	return result(delivered), nil
}
