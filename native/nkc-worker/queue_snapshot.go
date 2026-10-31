package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

const binaryQueuePayloadFormat = "nkcp-v2"
const queueSnapshotMetadataLimit = 64 * 1024 * 1024
const queueSnapshotPayloadLimit = 512 * 1024 * 1024
const queueSnapshotMessageLimit = 65536

var queueSnapshotMagic = []byte{'N', 'K', 'C', 'Q', 1}
var binaryOwnedRetryPattern = regexp.MustCompile(`^owned-binary-v1:[a-f0-9]{64}$`)

func payloadFormatForOwnedID(id string) string {
	if binaryOwnedRetryPattern.MatchString(id) {
		return binaryQueuePayloadFormat
	}
	return ""
}

type binaryQueueSnapshotMetadata struct {
	Queue   queueFile `json:"queue"`
	Lengths []uint32  `json:"lengths"`
}

// NKCQ v1 metadata is versioned with its schema; changing its fields requires a retained v1 reader.
func validateQueueSnapshotRecords(messages []queuedMessage) error {
	seen := make(map[string]bool, len(messages))
	for _, message := range messages {
		account := message.AccountID
		if strings.TrimSpace(account) == "" {
			account = legacyAccountID
		}
		key := account + "\x00" + message.ID
		if seen[key] {
			return fmt.Errorf("duplicate_queue_identity")
		}
		seen[key] = true
		if message.PayloadFormat == "" && strings.HasPrefix(message.ID, "owned-binary-v1:") {
			return fmt.Errorf("binary_queue_format_required")
		}
	}
	return nil
}

// A Go string holds opaque immutable bytes here, not a text or Base64 encoding.
func ownedBinaryRetryID(payload string) string {
	digest := sha256.Sum256([]byte("NKC|OWNED-BINARY|1\x00" + payload))
	return "owned-binary-v1:" + hex.EncodeToString(digest[:])
}

// Legacy JSON IPC may inspect status, but cannot encode raw payloads as text.
func (message queuedMessage) MarshalJSON() ([]byte, error) {
	type metadata queuedMessage
	if message.PayloadFormat != "" {
		message.Payload = ""
	}
	return json.Marshal(metadata(message))
}

func readQueueSnapshotFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	prefix := make([]byte, 4)
	_, err = io.ReadFull(file, prefix)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	if bytes.Equal(prefix, queueSnapshotMagic[:4]) {
		limit := int64(13 + queueSnapshotMetadataLimit + queueSnapshotPayloadLimit)
		raw, err := io.ReadAll(io.LimitReader(file, limit+1))
		if err == nil && int64(len(raw)) > limit {
			return nil, fmt.Errorf("queue_snapshot_too_large")
		}
		return raw, err
	}
	return io.ReadAll(file)
}

func writeQueueSnapshotFile(path string, raw []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(raw); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func encodeQueueSnapshot(state queueFile) ([]byte, error) {
	hasBinary := false
	for _, message := range state.Messages {
		if message.PayloadFormat == "" && strings.HasPrefix(message.ID, "owned-binary-v1:") {
			return nil, fmt.Errorf("binary_queue_format_required")
		}
		if message.PayloadFormat != "" {
			hasBinary = true
		}
	}
	if !hasBinary {
		return json.Marshal(state)
	}
	if len(state.Messages) > queueSnapshotMessageLimit {
		return nil, fmt.Errorf("queue_snapshot_too_many_records")
	}
	if err := validateQueueSnapshotRecords(state.Messages); err != nil {
		return nil, err
	}
	metadata := binaryQueueSnapshotMetadata{Queue: state, Lengths: make([]uint32, len(state.Messages))}
	metadata.Queue.Messages = append([]queuedMessage(nil), state.Messages...)
	total := 0
	for index, message := range state.Messages {
		if message.PayloadFormat == "" {
			continue
		}
		if message.PayloadFormat != binaryQueuePayloadFormat || len(message.Payload) > 2*1024*1024 {
			return nil, fmt.Errorf("invalid_queue_payload_format")
		}
		if err := validateBinaryQueuePayload(message); err != nil {
			return nil, err
		}
		metadata.Lengths[index] = uint32(len(message.Payload))
		metadata.Queue.Messages[index].Payload = ""
		total += len(message.Payload)
		if total > queueSnapshotPayloadLimit {
			return nil, fmt.Errorf("queue_snapshot_too_large")
		}
	}
	header, err := json.Marshal(metadata)
	if err != nil {
		return nil, err
	}
	if len(header) > queueSnapshotMetadataLimit {
		return nil, fmt.Errorf("queue_snapshot_metadata_too_large")
	}
	result := make([]byte, 13+len(header), 13+len(header)+total)
	copy(result, queueSnapshotMagic)
	binary.BigEndian.PutUint32(result[5:9], uint32(len(header)))
	binary.BigEndian.PutUint32(result[9:13], uint32(total))
	copy(result[13:], header)
	for _, message := range state.Messages {
		if message.PayloadFormat == binaryQueuePayloadFormat {
			result = append(result, message.Payload...)
		}
	}
	return result, nil
}

func decodeQueueSnapshot(raw []byte) (queueFile, error) {
	var state queueFile
	if !bytes.HasPrefix(raw, queueSnapshotMagic[:4]) {
		if err := json.Unmarshal(raw, &state); err != nil {
			return state, err
		}
		for _, message := range state.Messages {
			if message.PayloadFormat != "" || strings.HasPrefix(message.ID, "owned-binary-v1:") {
				return queueFile{}, fmt.Errorf("binary_payload_in_legacy_snapshot")
			}
		}
		return state, nil
	}
	if len(raw) < 13 || !bytes.Equal(raw[:5], queueSnapshotMagic) {
		return state, fmt.Errorf("unsupported_queue_snapshot")
	}
	headerLength := uint64(binary.BigEndian.Uint32(raw[5:9]))
	payloadLength := uint64(binary.BigEndian.Uint32(raw[9:13]))
	if headerLength > queueSnapshotMetadataLimit || payloadLength > queueSnapshotPayloadLimit ||
		13+headerLength+payloadLength != uint64(len(raw)) {
		return state, fmt.Errorf("invalid_queue_snapshot_length")
	}
	var metadata binaryQueueSnapshotMetadata
	header := raw[13 : 13+headerLength]
	if err := json.Unmarshal(header, &metadata); err != nil {
		return state, err
	}
	canonical, err := json.Marshal(metadata)
	if err != nil || !bytes.Equal(canonical, header) {
		return state, fmt.Errorf("noncanonical_queue_metadata")
	}
	if len(metadata.Queue.Messages) > queueSnapshotMessageLimit || len(metadata.Lengths) != len(metadata.Queue.Messages) {
		return state, fmt.Errorf("invalid_queue_snapshot_records")
	}
	if err := validateQueueSnapshotRecords(metadata.Queue.Messages); err != nil {
		return state, err
	}
	offset := uint64(13) + headerLength
	for index := range metadata.Queue.Messages {
		message := &metadata.Queue.Messages[index]
		length := uint64(metadata.Lengths[index])
		if message.PayloadFormat == "" {
			if length != 0 {
				return state, fmt.Errorf("legacy_queue_raw_payload")
			}
			continue
		}
		if message.PayloadFormat != binaryQueuePayloadFormat || message.Payload != "" || length > 2*1024*1024 ||
			offset+length > uint64(len(raw)) {
			return state, fmt.Errorf("invalid_queue_payload_format")
		}
		message.Payload = string(raw[offset : offset+length])
		if err := validateBinaryQueuePayload(*message); err != nil {
			return state, err
		}
		offset += length
	}
	if offset != uint64(len(raw)) {
		return state, fmt.Errorf("trailing_queue_payload")
	}
	return metadata.Queue, nil
}

func validateBinaryQueuePayload(message queuedMessage) error {
	if message.TransportRetryDigest != "" {
		return fmt.Errorf("binary_queue_legacy_retry_digest")
	}
	if !binaryOwnedRetryPattern.MatchString(message.ID) {
		return fmt.Errorf("invalid_binary_queue_id")
	}
	if message.Payload == "" {
		if message.Status != "DELIVERED" && message.Status != "CANCELLED" {
			return fmt.Errorf("missing_binary_queue_payload")
		}
		return nil
	}
	digest := sha256.Sum256([]byte(message.Payload))
	if message.ID != ownedBinaryRetryID(message.Payload) || message.ImmutablePayloadDigest != hex.EncodeToString(digest[:]) {
		return fmt.Errorf("binary_queue_identity_mismatch")
	}
	return nil
}
