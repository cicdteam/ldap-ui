// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

//go:build unix && !aix && !solaris

package profile

import (
	"strings"
	"testing"
)

func TestDataDirLocked(t *testing.T) {
	dir := t.TempDir()
	first, err := NewCatalog(nil, dir)
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	if c, err := NewCatalog(nil, dir); err == nil || !strings.Contains(err.Error(), dir) {
		if c != nil {
			_ = c.Close()
		}
		t.Errorf("second NewCatalog(%q) error = %v, want an error naming the dir", dir, err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	newCatalog(t, dir)
}
