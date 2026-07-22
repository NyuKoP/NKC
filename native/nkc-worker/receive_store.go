package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

const (
	receiveChunkSize      = int64(1024 * 1024)
	receiveMaxFileSize    = int64(500 * 1024 * 1024)
	checkpointBytes       = int64(32 * 1024 * 1024)
	checkpointMaxInterval = time.Second
)

var transferIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type receiveInitParams struct {
	Directory   string `json:"directory"`
	TransferID  string `json:"transferId"`
	FileName    string `json:"fileName"`
	FileSize    int64  `json:"fileSize"`
	ChunkSize   int64  `json:"chunkSize"`
	TotalChunks int64  `json:"totalChunks"`
	SHA256      string `json:"sha256"`
}

type receiveWriteParams struct {
	TransferID string `json:"transferId"`
	Index      int64  `json:"index"`
	Data       string `json:"data"`
}

type receiveIDParams struct {
	TransferID string `json:"transferId"`
}

type receiveJournal struct {
	Version     int    `json:"version"`
	TransferID  string `json:"transferId"`
	FileName    string `json:"fileName"`
	FileSize    int64  `json:"fileSize"`
	ChunkSize   int64  `json:"chunkSize"`
	TotalChunks int64  `json:"totalChunks"`
	SHA256      string `json:"sha256"`
	Bitmap      []byte `json:"bitmap"`
}

type receiveTransfer struct {
	mu             sync.Mutex
	journal        receiveJournal
	file           *os.File
	tmpPath        string
	journalPath    string
	finalPath      string
	dirtyBytes     int64
	lastCheckpoint time.Time
	durableBitmap  []byte
}

type receiveManager struct {
	mu        sync.RWMutex
	transfers map[string]*receiveTransfer
}

func newReceiveManager() *receiveManager {
	return &receiveManager{transfers: make(map[string]*receiveTransfer)}
}

func validateReceiveInit(p receiveInitParams) error {
	if !transferIDPattern.MatchString(p.TransferID) {
		return fmt.Errorf("invalid_transfer_id")
	}
	if p.FileSize < 1 || p.FileSize > receiveMaxFileSize {
		return fmt.Errorf("invalid_file_size")
	}
	if p.ChunkSize != receiveChunkSize {
		return fmt.Errorf("invalid_chunk_size")
	}
	if p.TotalChunks != (p.FileSize+p.ChunkSize-1)/p.ChunkSize {
		return fmt.Errorf("invalid_total_chunks")
	}
	decoded, err := hex.DecodeString(p.SHA256)
	if err != nil || len(decoded) != sha256.Size {
		return fmt.Errorf("invalid_sha256")
	}
	if p.Directory == "" {
		return fmt.Errorf("invalid_directory")
	}
	if filepath.Base(p.FileName) != p.FileName || p.FileName == "." || p.FileName == ".." || p.FileName == "" {
		return fmt.Errorf("invalid_file_name")
	}
	return nil
}

func (m *receiveManager) init(p receiveInitParams) (any, error) {
	if err := validateReceiveInit(p); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(p.Directory, 0700); err != nil {
		return nil, err
	}
	base := filepath.Join(p.Directory, p.TransferID)
	tmpPath, journalPath := base+".part", base+".journal"
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing := m.transfers[p.TransferID]; existing != nil {
		return existing.status(), nil
	}
	j := receiveJournal{Version: 1, TransferID: p.TransferID, FileName: p.FileName, FileSize: p.FileSize, ChunkSize: p.ChunkSize, TotalChunks: p.TotalChunks, SHA256: p.SHA256, Bitmap: make([]byte, (p.TotalChunks+7)/8)}
	if raw, err := os.ReadFile(journalPath); err == nil {
		if err := json.Unmarshal(raw, &j); err != nil {
			return nil, fmt.Errorf("invalid_receive_journal")
		}
		if j.TransferID != p.TransferID || j.FileSize != p.FileSize || j.ChunkSize != p.ChunkSize || j.TotalChunks != p.TotalChunks || j.SHA256 != p.SHA256 {
			return nil, fmt.Errorf("receive_manifest_mismatch")
		}
	}
	flags := os.O_RDWR | os.O_CREATE
	if _, err := os.Stat(tmpPath); os.IsNotExist(err) {
		flags |= os.O_EXCL
	}
	f, err := os.OpenFile(tmpPath, flags, 0600)
	if err != nil {
		return nil, err
	}
	if err = preallocatePlatform(f, p.FileSize); err != nil {
		f.Close()
		return nil, err
	}
	t := &receiveTransfer{journal: j, file: f, tmpPath: tmpPath, journalPath: journalPath, finalPath: filepath.Join(p.Directory, p.FileName), lastCheckpoint: time.Now(), durableBitmap: append([]byte(nil), j.Bitmap...)}
	m.transfers[p.TransferID] = t
	return t.status(), nil
}

func (m *receiveManager) get(id string) (*receiveTransfer, error) {
	m.mu.RLock()
	t := m.transfers[id]
	m.mu.RUnlock()
	if t == nil {
		return nil, fmt.Errorf("receive_not_initialized")
	}
	return t, nil
}

func bitSet(bitmap []byte, index int64) bool { return bitmap[index/8]&(1<<uint(index%8)) != 0 }
func setBit(bitmap []byte, index int64)      { bitmap[index/8] |= 1 << uint(index%8) }

func (t *receiveTransfer) status() map[string]any {
	received := int64(0)
	for i := int64(0); i < t.journal.TotalChunks; i++ {
		if bitSet(t.journal.Bitmap, i) {
			received++
		}
	}
	durableThrough := int64(-1)
	for i := int64(0); i < t.journal.TotalChunks && bitSet(t.durableBitmap, i); i++ {
		durableThrough = i
	}
	return map[string]any{
		"transferId": t.journal.TransferID, "receivedChunks": received,
		"receivedRanges": bitmapRanges(t.journal.Bitmap, t.journal.TotalChunks),
		"durableThrough": durableThrough, "totalChunks": t.journal.TotalChunks,
		"complete": received == t.journal.TotalChunks,
	}
}

func bitmapRanges(bitmap []byte, total int64) [][2]int64 {
	ranges := make([][2]int64, 0)
	for i := int64(0); i < total; {
		if !bitSet(bitmap, i) {
			i++
			continue
		}
		start := i
		for i+1 < total && bitSet(bitmap, i+1) {
			i++
		}
		ranges = append(ranges, [2]int64{start, i})
		i++
	}
	return ranges
}

func (m *receiveManager) write(p receiveWriteParams) (any, error) {
	data, err := base64.RawURLEncoding.DecodeString(p.Data)
	if err != nil {
		return nil, fmt.Errorf("invalid_chunk_data")
	}
	return m.writeBinary(p.TransferID, p.Index, data)
}

func (m *receiveManager) writeBinary(transferID string, index int64, data []byte) (any, error) {
	t, err := m.get(transferID)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if index < 0 || index >= t.journal.TotalChunks {
		return nil, fmt.Errorf("chunk_out_of_range")
	}
	expected := t.journal.ChunkSize
	if remaining := t.journal.FileSize - index*t.journal.ChunkSize; remaining < expected {
		expected = remaining
	}
	if int64(len(data)) != expected {
		return nil, fmt.Errorf("invalid_chunk_length")
	}
	if bitSet(t.journal.Bitmap, index) {
		return map[string]any{"duplicate": true, "checkpointed": true}, nil
	}
	n, err := t.file.WriteAt(data, index*t.journal.ChunkSize)
	if err != nil || n != len(data) {
		if err == nil {
			err = io.ErrShortWrite
		}
		return nil, err
	}
	setBit(t.journal.Bitmap, index)
	t.dirtyBytes += int64(n)
	due := t.dirtyBytes >= checkpointBytes || time.Since(t.lastCheckpoint) >= checkpointMaxInterval
	if due {
		if err := t.checkpointLocked(); err != nil {
			return nil, err
		}
	}
	return map[string]any{"duplicate": false, "checkpointed": due}, nil
}

func (t *receiveTransfer) checkpointLocked() error {
	if t.dirtyBytes == 0 {
		if _, err := os.Stat(t.journalPath); err == nil {
			return nil
		}
	}
	// Durable ACK boundary: file data first, journal second, ACK only after this returns.
	if err := t.file.Sync(); err != nil {
		return err
	}
	raw, err := json.Marshal(t.journal)
	if err != nil {
		return err
	}
	tmp := t.journalPath + ".tmp"
	jf, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if _, err = jf.Write(raw); err == nil {
		err = jf.Sync()
	}
	if closeErr := jf.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, t.journalPath); err != nil {
		return err
	}
	if err = syncParentDirectory(t.journalPath); err != nil {
		return err
	}
	t.durableBitmap = append(t.durableBitmap[:0], t.journal.Bitmap...)
	t.dirtyBytes = 0
	t.lastCheckpoint = time.Now()
	return nil
}

func (m *receiveManager) checkpoint(id string) (any, error) {
	t, err := m.get(id)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := t.checkpointLocked(); err != nil {
		return nil, err
	}
	return t.status(), nil
}

func (m *receiveManager) finalize(id string) (any, error) {
	t, err := m.get(id)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := int64(0); i < t.journal.TotalChunks; i++ {
		if !bitSet(t.journal.Bitmap, i) {
			return nil, fmt.Errorf("receive_incomplete")
		}
	}
	if err := t.checkpointLocked(); err != nil {
		return nil, err
	}
	if _, err := t.file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	h := sha256.New()
	if _, err := io.Copy(h, t.file); err != nil {
		return nil, err
	}
	if hex.EncodeToString(h.Sum(nil)) != t.journal.SHA256 {
		return nil, fmt.Errorf("file_hash_mismatch")
	}
	if err := t.file.Close(); err != nil {
		return nil, err
	}
	if _, err := os.Stat(t.finalPath); err == nil {
		return nil, fmt.Errorf("destination_exists")
	}
	if err := os.Rename(t.tmpPath, t.finalPath); err != nil {
		return nil, err
	}
	if err := syncParentDirectory(t.finalPath); err != nil {
		return nil, err
	}
	if err := os.Remove(t.journalPath); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	m.mu.Lock()
	delete(m.transfers, id)
	m.mu.Unlock()
	return map[string]any{"path": t.finalPath, "sha256": t.journal.SHA256}, nil
}

func (m *receiveManager) abort(id string) (any, error) {
	t, err := m.get(id)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := t.file.Close(); err != nil {
		return nil, err
	}
	for _, path := range []string{t.tmpPath, t.journalPath, t.journalPath + ".tmp"} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	m.mu.Lock()
	delete(m.transfers, id)
	m.mu.Unlock()
	return map[string]bool{"aborted": true}, nil
}
