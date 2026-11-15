// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

//go:build unix && !aix && !solaris

package profile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// lockDir takes an exclusive lock on dir/.lock, so that two processes never
// write the same profiles.json. Closing the returned file releases it.
func lockDir(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_RDWR|os.O_CREATE, 0o600) //nolint:gosec // dir is the operator's --data-dir
	if err != nil {
		return nil, err
	}
	switch err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); {
	case errors.Is(err, syscall.EWOULDBLOCK):
		_ = f.Close()
		return nil, fmt.Errorf("data dir %s is in use by another ldapui process", dir)
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
