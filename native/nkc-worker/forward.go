package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	torTargetPattern  = regexp.MustCompile(`^[a-z2-7]{56}\.onion$`)
	ownedRetryPattern = regexp.MustCompile(`^owned:[a-f0-9]{64}$`)
)

type onionRoutePayload struct {
	To           string `json:"to"`
	From         string `json:"from"`
	Envelope     string `json:"envelope"`
	ToDeviceID   string `json:"toDeviceId"`
	ToOnion      string `json:"toOnion"`
	FromDeviceID string `json:"fromDeviceId"`
	Route        struct {
		Mode            string `json:"mode"`
		TorOnion        string `json:"torOnion"`
		InboxWriteToken string `json:"inboxWriteToken"`
	} `json:"route"`
}

type transportForwardParams struct {
	Payload        onionRoutePayload `json:"payload"`
	TorProxyURL    string            `json:"torProxyUrl"`
	QueueOnFailure bool              `json:"queueOnFailure"`
	AccountID      string            `json:"accountId"`
	OwnedRetryID   string            `json:"ownedRetryId,omitempty"`
	SessionToken   string            `json:"sessionToken,omitempty"`
	Diagnose       bool              `json:"diagnose,omitempty"`
	PayloadFormat  string            `json:"payloadFormat,omitempty"`
}

// Transport framing only. Signature, canonical metadata and session authentication remain at the receiver.
func binaryPacketID(body []byte) (string, error) {
	if len(body) < 13 || len(body) > queueRequestFrameLimit || !bytes.Equal(body[:5], []byte{'N', 'K', 'C', 'P', 2}) {
		return "", fmt.Errorf("invalid_binary_packet")
	}
	headerSize, payloadSize := uint64(binary.BigEndian.Uint32(body[5:9])), uint64(binary.BigEndian.Uint32(body[9:13]))
	if headerSize == 0 || headerSize > 64*1024 || 13+headerSize+payloadSize != uint64(len(body)) {
		return "", fmt.Errorf("invalid_binary_packet_length")
	}
	if !utf8.Valid(body[13 : 13+headerSize]) {
		return "", fmt.Errorf("invalid_binary_packet_header")
	}
	decoder := json.NewDecoder(bytes.NewReader(body[13 : 13+headerSize]))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return "", fmt.Errorf("invalid_binary_packet_header")
	}
	seen, id := make(map[string]bool), ""
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] || key == "payload" {
			return "", fmt.Errorf("invalid_binary_packet_header")
		}
		seen[key] = true
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return "", fmt.Errorf("invalid_binary_packet_header")
		}
		if key == "id" && json.Unmarshal(value, &id) != nil {
			return "", fmt.Errorf("invalid_binary_packet_id")
		}
	}
	if _, err := decoder.Token(); err != nil || id == "" || len(id) > 512 {
		return "", fmt.Errorf("invalid_binary_packet_id")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return "", fmt.Errorf("invalid_binary_packet_header")
	}
	return id, nil
}

func binaryIngestHeaders(messageID, deviceID, token string) map[string]string {
	return map[string]string{"Content-Type": "application/vnd.nkc.packet-v2", "X-NKC-Transport-Id": messageID,
		"X-NKC-To-Device": url.PathEscape(deviceID), "X-NKC-Mailbox-Token": token}
}

type transportForwardResult struct {
	Status int              `json:"status"`
	Body   map[string]any   `json:"body"`
	Traces []map[string]any `json:"traces"`
}

type routeCandidate struct {
	kind   string
	target string
	proxy  string
}

func normalizeRouteTarget(kind, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if !strings.HasPrefix(value, "http://") {
		value = "http://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return ""
	}
	hostname := strings.ToLower(parsed.Hostname())
	if kind == "tor" && !torTargetPattern.MatchString(hostname) {
		return ""
	}
	return "http://" + parsed.Host
}

func buildRouteCandidates(mode, torTarget, torProxy string) []routeCandidate {
	tor := routeCandidate{kind: "tor", target: torTarget, proxy: strings.TrimSpace(torProxy)}
	hasTor := tor.target != "" && tor.proxy != ""
	switch mode {
	case "preferTor":
		if hasTor {
			return []routeCandidate{tor}
		}
	case "manual":
		if hasTor {
			return []routeCandidate{tor}
		}
	case "auto":
		if hasTor {
			return []routeCandidate{tor}
		}
	}
	return nil
}

func normalizeForwardError(err error) string {
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "ingest_failed:429") {
		return "upstream_rate_limited"
	}
	if strings.Contains(text, "ingest_failed:4") {
		return "permanent_upstream_rejection"
	}
	if strings.Contains(text, "ingest_failed:5") {
		return "upstream_http_error"
	}
	for _, code := range []string{"proxy_connect_timeout", "socks_handshake_timeout", "upstream_response_timeout"} {
		if strings.Contains(text, code) {
			return code
		}
	}
	if strings.Contains(text, "socks_reply_host_unreachable") {
		return "onion_descriptor_unavailable"
	}
	if strings.Contains(text, "socks_reply_network_unreachable") {
		return "tor_network_unreachable"
	}
	if strings.Contains(text, "socks_reply_connection_refused") {
		return "onion_service_refused"
	}
	if strings.Contains(text, "timeout") || strings.Contains(text, "deadline exceeded") {
		return "upstream_response_timeout"
	}
	if strings.Contains(text, "socks_auth") || strings.Contains(text, "socks_connect") || strings.Contains(text, "unsupported_socks") || strings.Contains(text, "invalid_socks") {
		return "handshake_failed"
	}
	if strings.Contains(text, "connection refused") || strings.Contains(text, "actively refused") || strings.Contains(text, "connectex") || strings.Contains(text, "no such host") || strings.Contains(text, "network is unreachable") || strings.Contains(text, "host is unreachable") || strings.Contains(text, "connection reset") || strings.Contains(text, "forcibly closed") || strings.Contains(text, "connect_fail") {
		return "proxy_unreachable"
	}
	return "upstream_error"
}

func forwardFailure(status int, msgID, code string, traces []map[string]any) transportForwardResult {
	return transportForwardResult{
		Status: status,
		Body:   map[string]any{"ok": false, "error": code},
		Traces: traces,
	}
}

func (w *worker) forwardOnion(params transportForwardParams) (result transportForwardResult, forwardErr error) {
	ctx := context.Background()
	payload := params.Payload
	if params.PayloadFormat != "" && (params.PayloadFormat != binaryQueuePayloadFormat || params.OwnedRetryID == "") {
		return transportForwardResult{}, fmt.Errorf("invalid_binary_forward")
	}
	if payload.Envelope == "" {
		return forwardFailure(http.StatusBadRequest, "", "missing-fields", nil), nil
	}
	msgID := newID()
	if params.OwnedRetryID != "" {
		validID := ownedRetryPattern.MatchString(params.OwnedRetryID)
		if params.PayloadFormat == binaryQueuePayloadFormat {
			_, err := binaryPacketID([]byte(payload.Envelope))
			validID = err == nil && params.OwnedRetryID == ownedBinaryRetryID(payload.Envelope) && payload.Route.InboxWriteToken != ""
		}
		if !validID || params.AccountID == "" || params.AccountID == legacyAccountID {
			return transportForwardResult{}, fmt.Errorf("invalid_owned_retry")
		}
		msgID = params.OwnedRetryID
		if queue := w.getQueue(); queue != nil && queue.applicationConfirmed(params.AccountID, msgID) {
			return transportForwardResult{Status: http.StatusOK, Body: map[string]any{"ok": true, "msgId": msgID, "forwarded": false}}, nil
		}
	}
	now := time.Now().UnixMilli()
	toDeviceID := payload.ToDeviceID
	if toDeviceID == "" {
		toDeviceID = payload.To
	}
	fromDeviceID := payload.FromDeviceID
	if fromDeviceID == "" {
		fromDeviceID = payload.From
	}
	if toDeviceID == "" {
		return forwardFailure(http.StatusBadRequest, msgID, "missing-to-device", nil), nil
	}
	if params.OwnedRetryID != "" {
		if queue := w.getQueue(); queue != nil {
			// Independent forwards must not wait behind an offline batch; revoke still fences every in-flight send.
			var finish func()
			ctx, finish = queue.beginDispatch()
			defer finish()
			if !queue.currentSession(params.AccountID, params.SessionToken) {
				return forwardFailure(http.StatusForbidden, msgID, "owner_session_changed", nil), nil
			}
			if queue.applicationCancelled(params.AccountID, params.OwnedRetryID) {
				return forwardFailure(http.StatusForbidden, msgID, "application_cancelled", nil), nil
			}
			if queue.deviceRevoked(params.AccountID, toDeviceID) {
				return forwardFailure(http.StatusForbidden, msgID, "device_authority_revoked", nil), nil
			}
		}
	}
	if len(toDeviceID) > 256 || len(fromDeviceID) > 256 {
		return forwardFailure(http.StatusBadRequest, msgID, "invalid-device-id", nil), nil
	}
	mode := payload.Route.Mode
	if mode == "" {
		mode = "manual"
	}
	if mode != "auto" && mode != "preferTor" && mode != "manual" {
		return forwardFailure(http.StatusBadRequest, msgID, "invalid-route-mode", nil), nil
	}
	torValue := payload.ToOnion
	if torValue == "" {
		torValue = payload.Route.TorOnion
	}
	if torValue == "" && strings.Contains(payload.To, ".onion") {
		torValue = payload.To
	}
	torTarget := normalizeRouteTarget("tor", torValue)
	if torValue != "" && torTarget == "" {
		return forwardFailure(http.StatusBadRequest, msgID, "invalid-route-target", nil), nil
	}

	candidates := buildRouteCandidates(mode, torTarget, params.TorProxyURL)
	traces := make([]map[string]any, 0, len(candidates)*2)
	traceID := msgID
	if params.PayloadFormat == binaryQueuePayloadFormat {
		traceID = newID()
	}
	terminalCode := "forward_failed:no_route"
	terminalStatus := http.StatusBadRequest
	ownedTransportAccepted := false
	ownedForwardClaimed := false
	var ownedForwardToken *byte
	var ownedFailure error = fmt.Errorf("no_route")
	if params.OwnedRetryID != "" {
		if queue := w.getQueue(); !params.QueueOnFailure && queue != nil && queue.matchingActiveRetry(params.AccountID, msgID, toDeviceID, torTarget, payload.Envelope) {
			// Existing durable custody owns this exact in-flight retry; this is not peer receipt.
			return transportForwardResult{Status: http.StatusAccepted, Body: map[string]any{
				"ok": true, "msgId": msgID, "forwarded": false, "queued": true, "status": "IN_FLIGHT",
			}, Traces: []map[string]any{{"event": "onionController:offlineQueue:in-flight-reused", "routeKind": "tor"}}}, nil
		}
		if queue := w.getQueue(); queue != nil && params.QueueOnFailure && len(candidates) > 0 {
			message, claimed, err := queue.claimOwnedForward(enqueueParams{
				AccountID: params.AccountID, SessionToken: params.SessionToken, ID: msgID,
				FriendID: toDeviceID, OnionAddress: torTarget, Payload: payload.Envelope,
				InboxWriteToken: payload.Route.InboxWriteToken, CreatedAt: now, Immutable: true, PayloadFormat: params.PayloadFormat,
			})
			if err != nil {
				return transportForwardResult{}, err
			}
			if !claimed {
				if message.Status == "IN_FLIGHT" {
					traces = append(traces, map[string]any{"event": "onionController:offlineQueue:in-flight-reused", "routeKind": "tor"})
				}
				return transportForwardResult{Status: http.StatusAccepted, Body: map[string]any{
					"ok": true, "msgId": msgID, "forwarded": false, "queued": message.Status != "DELIVERED", "status": message.Status,
				}, Traces: traces}, nil
			}
			ownedForwardClaimed = true
			ownedForwardToken = message.token
			defer func() {
				queue.mu.Lock()
				defer queue.mu.Unlock()
				claimKey := message.AccountID + "\x00" + message.ID
				if queue.ownedForwardClaims[claimKey] != message.token {
					return
				}
				defer delete(queue.ownedForwardClaims, claimKey)
				var err error
				if ownedTransportAccepted {
					err = queue.patchStatus(params.AccountID, map[string]bool{msgID: true}, "DELIVERED", "")
				} else {
					err = queue.patchFailure(params.AccountID, msgID, ownedFailure)
				}
				if err != nil {
					forwardErr = fmt.Errorf("queue_forward_settle:%w", err)
				}
			}()
		}
	}
	for index, candidate := range candidates {
		attemptStarted := time.Now()
		slotsUsedAtStart := len(w.transport.slots)
		targetURL := candidate.target + "/onion/ingest"
		traces = append(traces, map[string]any{
			"event": "onionController:forward:start", "opId": traceID,
			"routeKind": candidate.kind, "routeMode": mode,
			"attempt": index + 1, "maxRouteAttempts": len(candidates), "timeoutMs": 45_000,
		})
		var body []byte
		var err error
		headers := map[string]string{"Content-Type": "application/json"}
		if params.PayloadFormat == binaryQueuePayloadFormat {
			body = []byte(payload.Envelope)
			headers = binaryIngestHeaders(msgID, toDeviceID, payload.Route.InboxWriteToken)
		} else {
			body, err = json.Marshal(map[string]any{
				"toDeviceId": toDeviceID, "from": fromDeviceID, "envelope": payload.Envelope,
				"ts": now, "id": msgID, "inboxWriteToken": payload.Route.InboxWriteToken,
			})
		}
		if err != nil {
			return transportForwardResult{}, err
		}
		response, err := w.transport.fetch(transportFetchParams{
			context: ctx,
			URL:     targetURL, Method: http.MethodPost,
			Headers: headers,
			Body:    body, TimeoutMS: 45_000,
			SocksProxyURL: candidate.proxy, Retry: transportRetryParams{Attempts: 1, DelayMS: 350}, Diagnose: params.Diagnose,
		})
		if err == nil && response.Status >= 200 && response.Status < 300 {
			var raw []byte
			raw, err = base64.StdEncoding.DecodeString(response.BodyBase64)
			if err == nil {
				err = validateIngestAck(raw, response.Status, msgID)
			}
		}
		if err == nil && response.Status >= 200 && response.Status < 300 {
			ownedTransportAccepted = true
			resultTrace := map[string]any{
				"event": "onionController:forward:ok", "opId": traceID,
				"routeKind": candidate.kind, "routeMode": mode, "status": response.Status,
				"attempt": index + 1, "maxRouteAttempts": len(candidates),
			}
			if params.Diagnose {
				resultTrace["durationMs"] = time.Since(attemptStarted).Milliseconds()
				resultTrace["slotsUsedAtStart"] = slotsUsedAtStart
				resultTrace["stageDurationsMs"] = response.StageDurationsMS
				resultTrace["connectionCounts"] = response.ConnectionCounts
			}
			traces = append(traces, resultTrace)
			return transportForwardResult{
				Status: http.StatusOK,
				Body:   map[string]any{"ok": true, "msgId": msgID, "forwarded": true, "via": candidate.kind},
				Traces: traces,
			}, nil
		}
		code := "upstream_error"
		if err != nil {
			ownedFailure = err
			code = normalizeForwardError(err)
		} else {
			ownedFailure = fmt.Errorf("ingest_failed:%d", response.Status)
			code = normalizeForwardError(ownedFailure)
		}
		failureTrace := map[string]any{
			"event": "onionController:forward:fail", "level": "warn", "opId": traceID,
			"routeKind": candidate.kind, "routeMode": mode, "normalizedCode": code,
			"attempt": index + 1, "maxRouteAttempts": len(candidates),
		}
		if params.Diagnose {
			failureTrace["durationMs"] = time.Since(attemptStarted).Milliseconds()
			failureTrace["networkStage"] = forwardNetworkStage(err)
			failureTrace["slotsUsedAtStart"] = slotsUsedAtStart
			failureTrace["stageDurationsMs"] = response.StageDurationsMS
			failureTrace["connectionCounts"] = response.ConnectionCounts
		}
		traces = append(traces, failureTrace)
		terminalCode = "forward_failed:" + code
		terminalStatus = http.StatusBadGateway
		if mode != "auto" {
			break
		}
	}

	shouldQueue := params.QueueOnFailure && torTarget != ""
	if shouldQueue {
		queue := w.getQueue()
		if queue != nil {
			accountID := strings.TrimSpace(params.AccountID)
			if accountID == "" {
				accountID = queue.activeAccount()
			}
			queue.mu.Lock()
			if ownedForwardClaimed {
				found := false
				for _, message := range queue.state.Messages {
					if message.AccountID == accountID && message.ID == msgID &&
						queue.ownedForwardClaims[accountID+"\x00"+msgID] == ownedForwardToken {
						found = true
						break
					}
				}
				if !found {
					queue.mu.Unlock()
					return forwardFailure(http.StatusGone, msgID, "owned_retry_removed", traces), nil
				}
			}
			item, err := queue.enqueueLocked(enqueueParams{
				AccountID:    accountID,
				SessionToken: params.SessionToken,
				ID:           msgID, FriendID: toDeviceID, OnionAddress: torTarget,
				Payload: payload.Envelope, InboxWriteToken: payload.Route.InboxWriteToken,
				CreatedAt:     now,
				Immutable:     params.OwnedRetryID != "",
				PayloadFormat: params.PayloadFormat,
			})
			queue.mu.Unlock()
			if err != nil {
				return transportForwardResult{}, fmt.Errorf("queue_forward_failure:%w", err)
			}
			if item.Status == "DELIVERED" && item.LastError == "application-receipt" {
				return transportForwardResult{Status: http.StatusOK, Body: map[string]any{"ok": true, "msgId": msgID, "forwarded": false}}, nil
			}
			traces = append(traces, map[string]any{
				"event": "onionController:offlineQueue:pending", "level": "warn",
				"opId":   traceID,
				"reason": terminalCode,
			})
			return transportForwardResult{
				Status: http.StatusAccepted,
				Body: map[string]any{
					"ok": true, "msgId": msgID, "forwarded": false, "queued": true,
					"status": "PENDING", "error": terminalCode,
				},
				Traces: traces,
			}, nil
		}
	}
	return forwardFailure(terminalStatus, msgID, terminalCode, traces), nil
}

// Only fixed stage names may leave the worker's diagnostic path.
func forwardNetworkStage(err error) string {
	if err == nil {
		return "http_response"
	}
	for _, stage := range []string{"admission", "connection", "proxy_connect", "socks_handshake", "socks_connect", "http_request", "http_request_body", "http_response", "http_response_headers", "http_body", "retry_wait"} {
		if strings.HasPrefix(err.Error(), "probe_stage_"+stage+":") {
			return stage
		}
	}
	return "unknown"
}
