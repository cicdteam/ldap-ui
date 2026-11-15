// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"regexp"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
)

// fields turns slog key/value pairs into a map.
func fields(kv []any) map[string]any {
	m := make(map[string]any)
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i].(string)] = kv[i+1]
	}
	return m
}

func TestWho(t *testing.T) {
	const header = "X-Auth-Request-Email"
	s := &server{identityHeader: header, trustedProxies: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}}
	request := func(remote, user, sessionID string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = remote
		if user != "" {
			r.Header.Set(header, user)
		}
		if sessionID != "" {
			r.AddCookie(cookieOptions{}.cookie(sessionCookie, sessionID, r))
		}
		return r
	}

	const id = "SESSIONIDSESSIONIDSESSIONID"
	fp, _ := fields(s.who(request("192.0.2.1:1", "", id)))["session"].(string)
	if !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(fp) || strings.Contains(id, fp) {
		t.Errorf("who() session = %q, want 8 hex characters that are not the ID %q", fp, id)
	}
	if again := fields(s.who(request("192.0.2.1:1", "", id)))["session"]; again != fp {
		t.Errorf("who() session = %q, then %q, want the same fingerprint for the same ID", fp, again)
	}
	if other := fields(s.who(request("192.0.2.1:1", "", id+"2")))["session"]; other == fp {
		t.Errorf("who() session for two IDs = %q, want different fingerprints", fp)
	}

	tests := []struct {
		name   string
		s      *server
		remote string
		user   string
		want   map[string]any
	}{
		{
			name: "trusted proxy", s: s, remote: "10.0.0.5:1234", user: "alice@example.com",
			want: map[string]any{"session": "", "remote": "10.0.0.5:1234", "user": "alice@example.com"},
		},
		{
			name: "untrusted remote", s: s, remote: "192.0.2.1:1", user: "alice@example.com",
			want: map[string]any{"session": "", "remote": "192.0.2.1:1"},
		},
		{
			name: "header cut to 256 bytes", s: s, remote: "10.0.0.5:1234", user: strings.Repeat("a", 300),
			want: map[string]any{"session": "", "remote": "10.0.0.5:1234", "user": strings.Repeat("a", 256)},
		},
		{
			name: "no identity header configured", s: &server{trustedProxies: s.trustedProxies}, remote: "10.0.0.5:1234", user: "alice@example.com",
			want: map[string]any{"session": "", "remote": "10.0.0.5:1234"},
		},
		{
			name: "IPv4-mapped trusted proxy", s: s, remote: "[::ffff:10.0.0.5]:1234", user: "alice@example.com",
			want: map[string]any{"session": "", "remote": "[::ffff:10.0.0.5]:1234", "user": "alice@example.com"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := fields(tc.s.who(request(tc.remote, tc.user, "")))
			if diff := cmp.Diff(tc.want, got); diff != "" {
				t.Errorf("who() mismatch (-want +got):\n%s", diff)
			}
		})
	}
}
