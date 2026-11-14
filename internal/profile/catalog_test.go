// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package profile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestCatalogSaveAndReload(t *testing.T) {
	dir := t.TempDir()
	c, err := NewCatalog(nil, dir)
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	if _, err := c.Save(Profile{Name: "lab", URL: "ldap://lab:389"}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	reloaded, err := NewCatalog(nil, dir)
	if err != nil {
		t.Fatalf("NewCatalog() reload error = %v", err)
	}
	got, err := reloaded.Find("lab")
	if err != nil {
		t.Fatalf("Find(lab) error = %v", err)
	}
	if got.URL != "ldap://lab:389" || got.Environment != Dev {
		t.Errorf("Find(lab) = %+v, want url ldap://lab:389 and environment dev", got)
	}
}

func TestCatalogSaveStripsFileReferences(t *testing.T) {
	dir := t.TempDir()
	c, err := NewCatalog(nil, dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Save(Profile{Name: "x", URL: "ldap://h", PasswordFile: "/etc/passwd", PasswordEnv: "HOME", CAFile: "/etc/hosts"})
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if got.PasswordFile != "" || got.PasswordEnv != "" || got.CAFile != "" {
		t.Errorf("Save() = %+v, want file and env references cleared", got)
	}
}

func TestCatalogSaveErrors(t *testing.T) {
	fixed := []Profile{{Name: "corp", URL: "ldap://corp"}}
	withDir, err := NewCatalog(fixed, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	noDir, err := NewCatalog(fixed, "")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		c    *Catalog
		p    Profile
		want error
	}{
		{name: "fixed name", c: withDir, p: Profile{Name: "corp", URL: "ldap://other"}, want: ErrFixed},
		{name: "no data dir", c: noDir, p: Profile{Name: "x", URL: "ldap://h"}, want: ErrSavingDisabled},
		{name: "invalid", c: withDir, p: Profile{Name: "x", URL: "http://h"}, want: ErrInvalid},
		{name: "url credentials", c: withDir, p: Profile{Name: "x", URL: "ldap://cn=admin:s3cret@h:389"}, want: ErrInvalid},
	}
	for _, tc := range tests {
		if _, err := tc.c.Save(tc.p); !errors.Is(err, tc.want) {
			t.Errorf("%s: Save() error = %v, want %v", tc.name, err, tc.want)
		}
	}
}

func TestCatalogFixedShadowsSaved(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "profiles.json"), []byte(`[{"name":"corp","url":"ldap://saved"},{"name":"lab","url":"ldap://lab"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := NewCatalog([]Profile{{Name: "corp", URL: "ldap://corp"}}, dir)
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	fixed, saved := c.All()
	names := func(ps []Profile) []string {
		var out []string
		for _, p := range ps {
			out = append(out, p.Name+"="+p.URL)
		}
		return out
	}
	if diff := cmp.Diff([]string{"corp=ldap://corp"}, names(fixed)); diff != "" {
		t.Errorf("All() fixed mismatch (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff([]string{"lab=ldap://lab"}, names(saved)); diff != "" {
		t.Errorf("All() saved mismatch (-want +got):\n%s", diff)
	}
}

func TestCatalogFind(t *testing.T) {
	c, err := NewCatalog([]Profile{{Name: "corp", URL: "ldap://corp"}}, "")
	if err != nil {
		t.Fatal(err)
	}
	if p, err := c.Find("corp"); err != nil || p.Environment != Dev {
		t.Errorf("Find(corp) = %+v, %v, want normalized profile", p, err)
	}
	if _, err := c.Find("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Find(nope) error = %v, want ErrNotFound", err)
	}
}
