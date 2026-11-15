// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

//go:build unix && !aix && !solaris

package profile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDataDirLocked(t *testing.T) {
	dir := t.TempDir()
	first, err := NewCatalog(nil, dir)
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	if first.Unlocked() {
		t.Errorf("Unlocked() = true on a writable dir, want false")
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

func TestNewCatalogReadOnlyDir(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes to any directory")
	}
	dir := t.TempDir()
	writePath(t, filepath.Join(dir, "profiles.json"), `[{"name":"lab","url":"ldap://lab"}]`)
	if err := os.Chmod(dir, 0o500); err != nil { //nolint:gosec // a read-only test dir
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) }) //nolint:gosec // writable again for TempDir cleanup

	c := newCatalog(t, dir)
	if !c.Unlocked() {
		t.Errorf("Unlocked() = false on a read-only dir, want true")
	}
	if _, err := c.Find("lab"); err != nil {
		t.Errorf("Find(lab) error = %v, want the saved profile", err)
	}
	if _, err := c.Save(Profile{Name: "x", URL: "ldap://h"}); err == nil {
		t.Errorf("Save() on a read-only dir error = nil, want an error")
	}
}
