//go:build darwin

package main

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func preallocatePlatform(file *os.File, size int64) error {
	store := unix.Fstore_t{Flags: unix.F_ALLOCATECONTIG, Posmode: unix.F_PEOFPOSMODE, Length: size}
	if err := unix.FcntlFstore(file.Fd(), unix.F_PREALLOCATE, &store); err != nil {
		store.Flags = unix.F_ALLOCATEALL
		if err = unix.FcntlFstore(file.Fd(), unix.F_PREALLOCATE, &store); err != nil {
			return file.Truncate(size)
		}
	}
	return file.Truncate(size)
}

func syncParentDirectory(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
