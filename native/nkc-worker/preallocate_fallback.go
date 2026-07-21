//go:build !linux && !darwin && !windows

package main

import "os"

func preallocatePlatform(file *os.File, size int64) error { return file.Truncate(size) }
func syncParentDirectory(string) error                    { return nil }
