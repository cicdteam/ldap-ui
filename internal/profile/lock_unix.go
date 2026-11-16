// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

//go:build unix && !aix && !solaris

package profile

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// lockDir takes an exclusive lock on dir/.lock, so that two processes never
// write the same profiles.json. Closing the returned file releases it. It
// returns errNotWritable when dir is read-only or not writable for us.
func lockDir(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_RDWR|os.O_CREATE, 0o600) //nolint:gosec // dir is the operator's --data-dir
	if errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EROFS) {
		return nil, errNotWritable
	}
	if err != nil {
		return nil, err
	}
	switch err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); {
	case errors.Is(err, syscall.EWOULDBLOCK):
		_ = f.Close()
		return nil, fmt.Errorf("data dir %s is in use by another ldaplens process", dir)
	case err != nil:
		_ = f.Close()
		return nil, fmt.Errorf("lock data dir %s: %w", dir, err)
	}
	return f, nil
}

// syncDir makes a rename in dir durable.
func syncDir(dir string) error {
	d, err := os.Open(dir) //nolint:gosec // dir is the operator's --data-dir
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
