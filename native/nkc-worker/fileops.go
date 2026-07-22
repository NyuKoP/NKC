package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
)

const maxChunkSize = 1024 * 1024

type fileInspectParams struct {
	Path      string `json:"path"`
	ChunkSize int64  `json:"chunkSize"`
}

type fileChunkParams struct {
	Path      string `json:"path"`
	Index     int64  `json:"index"`
	ChunkSize int64  `json:"chunkSize"`
}

func validateChunkSize(size int64) error {
	if size < 1 || size > maxChunkSize {
		return fmt.Errorf("invalid_chunk_size")
	}
	return nil
}

func inspectFile(params fileInspectParams) (any, error) {
	if err := validateChunkSize(params.ChunkSize); err != nil {
		return nil, err
	}
	file, err := os.Open(params.Path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return nil, err
	}
	total := (info.Size() + params.ChunkSize - 1) / params.ChunkSize
	return map[string]any{
		"size": info.Size(), "chunkSize": params.ChunkSize, "total": total,
		"sha256": hex.EncodeToString(hash.Sum(nil)),
	}, nil
}

func readFileChunk(params fileChunkParams) (any, error) {
	metadata, buffer, err := readFileChunkBinary(params)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(buffer)
	metadata["data"] = base64.RawURLEncoding.EncodeToString(buffer)
	metadata["sha256"] = hex.EncodeToString(hash[:])
	return metadata, nil
}

func readFileChunkBinary(params fileChunkParams) (map[string]any, []byte, error) {
	if err := validateChunkSize(params.ChunkSize); err != nil {
		return nil, nil, err
	}
	if params.Index < 0 {
		return nil, nil, fmt.Errorf("invalid_chunk_index")
	}
	file, err := os.Open(params.Path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	offset := params.Index * params.ChunkSize
	if offset >= info.Size() {
		return nil, nil, fmt.Errorf("chunk_out_of_range")
	}
	length := params.ChunkSize
	if remaining := info.Size() - offset; remaining < length {
		length = remaining
	}
	buffer := make([]byte, length)
	if _, err = file.ReadAt(buffer, offset); err != nil && err != io.EOF {
		return nil, nil, err
	}
	return map[string]any{
		"index": params.Index,
		"bytes": len(buffer),
	}, buffer, nil
}
