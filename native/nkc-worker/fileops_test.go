package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestFileInspectAndChunk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "payload.bin")
	payload := make([]byte, 300_000)
	for index := range payload {
		payload[index] = byte((index*31 + 17) & 0xff)
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := inspectFile(fileInspectParams{Path: path, ChunkSize: 128 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	actual := result.(map[string]any)
	expectedHash := sha256.Sum256(payload)
	if actual["sha256"] != hex.EncodeToString(expectedHash[:]) {
		t.Fatalf("hash mismatch: %v", actual["sha256"])
	}
	if actual["total"] != int64(3) {
		t.Fatalf("unexpected chunks: %v", actual["total"])
	}
	chunk, err := readFileChunk(fileChunkParams{Path: path, Index: 2, ChunkSize: 128 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	if chunk.(map[string]any)["bytes"] != len(payload)-2*128*1024 {
		t.Fatalf("unexpected final chunk")
	}
}
