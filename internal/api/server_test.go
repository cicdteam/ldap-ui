// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealth(t *testing.T) {
	h := New(Options{})
	for _, path := range []string{"/healthz", "/readyz"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want %d", path, rec.Code, http.StatusOK)
		}
	}
}

func TestHealthUnderBasePath(t *testing.T) {
	h := New(Options{BasePath: "/ldap/"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ldap/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("GET /ldap/healthz = %d, want 200", rec.Code)
	}
}

// TestProbesAtRootWithBasePath checks that a kubelet probing /healthz finds
// the probes whatever the base path, without a token and by pod IP.
func TestProbesAtRootWithBasePath(t *testing.T) {
	h := New(Options{BasePath: "/ldap", AuthToken: "abcXYZ0129._~-ok"}) //nolint:gosec // test value, not a credential
	for _, path := range []string{"/healthz", "/readyz", "/ldap/healthz", "/ldap/readyz"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Host = "10.0.0.5:8080"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s with Host %s = %d, want %d", path, req.Host, rec.Code, http.StatusOK)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("GET %s X-Content-Type-Options = %q, want nosniff", path, got)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/ldap/api/profiles", nil)
	req.Host = "10.0.0.5:8080"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("GET /ldap/api/profiles with Host %s = %d, want %d", req.Host, rec.Code, http.StatusForbidden)
	}
}

func TestServerEndpoint(t *testing.T) {
	for _, tc := range []struct {
		server bool
		want   string
	}{
		{server: false, want: `{"mode":"local"}`},
		{server: true, want: `{"mode":"server"}`},
	} {
		env := newTestEnvWith(t, Options{Server: tc.server})
		rec := env.do(t, http.MethodGet, "/api/server", "")
		if got := strings.TrimSpace(rec.Body.String()); rec.Code != http.StatusOK || got != tc.want {
			t.Errorf("Server %v: GET /api/server = %d %s, want 200 %s", tc.server, rec.Code, got, tc.want)
		}
	}
}
