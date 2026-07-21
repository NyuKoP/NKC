package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestReceiveStoreWriteCheckpointAndFinalize(t *testing.T) {
	dir := t.TempDir()
	payload := []byte("unordered payload")
	hash := sha256.Sum256(payload)
	id := "018f47a0-7b75-7cc1-8c3f-5bc637ff1077"
	m := newReceiveManager()
	_, err := m.init(receiveInitParams{
		Directory: dir, TransferID: id, FileName: "received.bin",
		FileSize: int64(len(payload)), ChunkSize: receiveChunkSize, TotalChunks: 1,
		SHA256: hex.EncodeToString(hash[:]),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.write(receiveWriteParams{TransferID: id, Index: 0, Data: base64.RawURLEncoding.EncodeToString(payload)}); err != nil {
		t.Fatal(err)
	}
	if _, err = m.checkpoint(id); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(dir, id+".journal")); err != nil {
		t.Fatal(err)
	}
	if _, err = m.finalize(id); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(filepath.Join(dir, "received.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if string(actual) != string(payload) {
		t.Fatalf("payload mismatch: %q", actual)
	}
}

func TestReceiveStoreRejectsWrongChunkLength(t *testing.T) {
	m := newReceiveManager()
	id := "018f47a0-7b75-7cc1-8c3f-5bc637ff1077"
	hash := sha256.Sum256([]byte("123"))
	_, err := m.init(receiveInitParams{Directory: t.TempDir(), TransferID: id, FileName: "x", FileSize: 3, ChunkSize: receiveChunkSize, TotalChunks: 1, SHA256: hex.EncodeToString(hash[:])})
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.write(receiveWriteParams{TransferID: id, Index: 0, Data: base64.RawURLEncoding.EncodeToString([]byte("12"))})
	if err == nil || err.Error() != "invalid_chunk_length" {
		t.Fatalf("expected invalid_chunk_length, got %v", err)
	}
	if _, err = m.abort(id); err != nil {
		t.Fatal(err)
	}
}
