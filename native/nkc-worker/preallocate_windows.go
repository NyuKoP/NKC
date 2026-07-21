//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func preallocatePlatform(file *os.File, size int64) error {
	volume := filepath.VolumeName(file.Name()) + `\`
	path, err := windows.UTF16PtrFromString(volume)
	if err != nil {
		return err
	}
	var available uint64
	if err := windows.GetDiskFreeSpaceEx(path, &available, nil, nil); err != nil {
		return err
	}
	reserve := size / 10
	if reserve < 100*1024*1024 {
		reserve = 100 * 1024 * 1024
	}
	if available < uint64(size+reserve) {
		return fmt.Errorf("insufficient_disk_space")
	}
	return file.Truncate(size)
}

func syncParentDirectory(string) error { return nil }
