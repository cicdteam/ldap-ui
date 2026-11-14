// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package profile

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

// Errors returned by Catalog.
var (
	ErrNotFound       = errors.New("profile not found")
	ErrFixed          = errors.New("profile is defined in the config file and cannot be changed here")
	ErrSavingDisabled = errors.New("saving profiles needs --data-dir")
)

// Catalog combines profiles from the config file ("fixed") with profiles
// saved from the UI. It is safe for concurrent use.
type Catalog struct {
	fixed []Profile
	path  string // JSON file for saved profiles; empty disables saving

	mu    sync.Mutex
	saved []Profile
}

// NewCatalog returns a catalog of fixed plus the profiles previously saved
// in dataDir/profiles.json. An empty dataDir disables saving. Config-file
// profiles shadow saved ones with the same name: such saved entries are
// dropped, and the next Save removes them from disk.
func NewCatalog(fixed []Profile, dataDir string) (*Catalog, error) {
	fixed = slices.Clone(fixed)
	if err := normalizeAll(fixed); err != nil {
		return nil, err
	}
	c := &Catalog{fixed: fixed}
	if dataDir == "" {
		return c, nil
	}
	c.path = filepath.Join(dataDir, "profiles.json")
	b, err := os.ReadFile(c.path)
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &c.saved); err != nil {
		return nil, fmt.Errorf("parse %s: %w", c.path, err)
	}
	c.saved = slices.DeleteFunc(c.saved, func(s Profile) bool {
		return slices.ContainsFunc(fixed, func(f Profile) bool { return f.Name == s.Name })
	})
	if err := normalizeAll(c.saved); err != nil {
		return nil, fmt.Errorf("%s: %w", c.path, err)
	}
	return c, nil
}

// All returns copies of the fixed and the saved profiles.
func (c *Catalog) All() (fixed, saved []Profile) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.fixed), slices.Clone(c.saved)
}

// Find returns the profile called name.
func (c *Catalog) Find(name string) (Profile, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range slices.Concat(c.fixed, c.saved) {
		if p.Name == name {
			return p, nil
		}
	}
	return Profile{}, fmt.Errorf("%w: %s", ErrNotFound, name)
}

// Save validates p, creates or replaces the saved profile with the same
// name, and writes all saved profiles to disk. Saved profiles never refer
// to local files or environment variables.
func (c *Catalog) Save(p Profile) (Profile, error) {
	p.PasswordEnv, p.PasswordFile, p.CAFile = "", "", ""
	if err := p.normalize(); err != nil {
		return Profile{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.path == "" {
		return Profile{}, ErrSavingDisabled
	}
	if slices.ContainsFunc(c.fixed, func(f Profile) bool { return f.Name == p.Name }) {
		return Profile{}, fmt.Errorf("%w: %s", ErrFixed, p.Name)
	}
	next := slices.Clone(c.saved)
	if i := slices.IndexFunc(next, func(s Profile) bool { return s.Name == p.Name }); i >= 0 {
		next[i] = p
	} else {
		next = append(next, p)
	}
	if err := writeJSONAtomic(c.path, next); err != nil {
		return Profile{}, err
	}
	c.saved = next
	return p, nil
}

func writeJSONAtomic(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
