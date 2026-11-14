// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package profile

import (
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "connections.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoad(t *testing.T) {
	path := writeFile(t, `
connections:
  - name: corp-ad
    url: ldaps://dc1.corp.example:636
    baseDN: dc=corp,dc=example
    bindDN: cn=reader,dc=corp,dc=example
    passwordEnv: CORP_PW
    environment: prod
    searchTimeout: 1m
  - name: local
    url: ldap://localhost:389
    startTLS: true
`)
	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	want := []Profile{
		{
			Name: "corp-ad", URL: "ldaps://dc1.corp.example:636",
			BaseDN: "dc=corp,dc=example", BindDN: "cn=reader,dc=corp,dc=example",
			PasswordEnv: "CORP_PW", Environment: Prod,
			ConnectTimeout: 10 * time.Second, SearchTimeout: time.Minute,
		},
		{
			Name: "local", URL: "ldap://localhost:389", StartTLS: true, Environment: Dev,
			ConnectTimeout: 10 * time.Second, SearchTimeout: 30 * time.Second,
		},
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Load() mismatch (-want +got):\n%s", diff)
	}
}

func TestLoadRejects(t *testing.T) {
	tests := []struct {
		name        string
		yaml        string
		wantInvalid bool
	}{
		{name: "bad scheme", yaml: "connections: [{name: a, url: 'http://h'}]", wantInvalid: true},
		{name: "starttls with ldaps", yaml: "connections: [{name: a, url: 'ldaps://h', startTLS: true}]", wantInvalid: true},
		{name: "no host", yaml: "connections: [{name: a, url: 'ldap:///dc=x'}]", wantInvalid: true},
		{name: "bad environment", yaml: "connections: [{name: a, url: 'ldap://h', environment: qa}]", wantInvalid: true},
		{name: "bad name", yaml: "connections: [{name: 'a b', url: 'ldap://h'}]", wantInvalid: true},
		{name: "duplicate", yaml: "connections: [{name: a, url: 'ldap://h'}, {name: a, url: 'ldap://g'}]", wantInvalid: true},
		{name: "url credentials", yaml: "connections: [{name: a, url: 'ldap://cn=admin:s3cret@h:389'}]", wantInvalid: true},
		{name: "unknown field", yaml: "connections: [{name: a, url: 'ldap://h', pasword: x}]", wantInvalid: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(writeFile(t, tc.yaml))
			if err == nil {
				t.Fatal("Load() error = nil, want error")
			}
			if got := errors.Is(err, ErrInvalid); got != tc.wantInvalid {
				t.Errorf("errors.Is(%v, ErrInvalid) = %v, want %v", err, got, tc.wantInvalid)
			}
		})
	}
}

func TestLoadErrorHidesURLPassword(t *testing.T) {
	_, err := Load(writeFile(t, "connections: [{name: a, url: 'ldap://cn=admin:s3cret@h:badport'}]"))
	if err == nil || strings.Contains(err.Error(), "s3cret") {
		t.Errorf("Load() error = %v, want an error without the password", err)
	}
}

func TestIsReadOnly(t *testing.T) {
	yes, no := true, false
	tests := []struct {
		name string
		p    Profile
		want bool
	}{
		{name: "prod default", p: Profile{Environment: Prod}, want: true},
		{name: "dev default", p: Profile{Environment: Dev}, want: false},
		{name: "prod opted out", p: Profile{Environment: Prod, ReadOnly: &no}, want: false},
		{name: "dev opted in", p: Profile{Environment: Dev, ReadOnly: &yes}, want: true},
	}
	for _, tc := range tests {
		if got := tc.p.IsReadOnly(); got != tc.want {
			t.Errorf("%s: IsReadOnly() = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestConfiguredPassword(t *testing.T) {
	t.Setenv("LDAPUI_TEST_PW", "from-env")
	pwFile := filepath.Join(t.TempDir(), "pw")
	if err := os.WriteFile(pwFile, []byte("from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		p       Profile
		want    string
		wantOK  bool
		wantErr bool
	}{
		{name: "env", p: Profile{PasswordEnv: "LDAPUI_TEST_PW"}, want: "from-env", wantOK: true}, //nolint:gosec // env var name, not a credential
		{name: "file trims newline", p: Profile{PasswordFile: pwFile}, want: "from-file", wantOK: true},
		{name: "none", p: Profile{}, want: "", wantOK: false},
		{name: "env unset", p: Profile{PasswordEnv: "LDAPUI_TEST_UNSET"}, wantErr: true}, //nolint:gosec // env var name, not a credential
	}
	for _, tc := range tests {
		got, ok, err := tc.p.ConfiguredPassword()
		if (err != nil) != tc.wantErr {
			t.Errorf("%s: ConfiguredPassword() error = %v, wantErr %v", tc.name, err, tc.wantErr)
			continue
		}
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("%s: ConfiguredPassword() = %q, %v, want %q, %v", tc.name, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestTLSConfig(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	defer srv.Close()
	caPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))

	cfg, err := Profile{Name: "x", URL: "ldaps://dc1.example:636", CAPEM: caPEM}.TLSConfig()
	if err != nil {
		t.Fatalf("TLSConfig() error = %v", err)
	}
	if cfg.ServerName != "dc1.example" {
		t.Errorf("TLSConfig().ServerName = %q, want %q", cfg.ServerName, "dc1.example")
	}
	if cfg.RootCAs == nil {
		t.Error("TLSConfig().RootCAs = nil, want pool with the custom CA")
	}

	if _, err := (Profile{Name: "x", URL: "ldaps://h", CAPEM: "garbage"}).TLSConfig(); err == nil {
		t.Error("TLSConfig() with garbage CA error = nil, want error")
	}
}
