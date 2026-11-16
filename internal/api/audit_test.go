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

// trusting is a server that trusts the proxies in 10.0.0.0/8.
var trusting = &server{trustedProxies: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}}

// forwarded is a request from remote with xff as its X-Forwarded-For
// headers, none when empty.
func forwarded(remote string, xff ...string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = remote
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestClientAddr(t *testing.T) {
	tests := []struct {
		name   string
		remote string
		xff    []string
		want   string
	}{
		{name: "untrusted remote ignores the header", remote: "192.0.2.1:5000", xff: []string{"1.2.3.4"}, want: "192.0.2.1"},
		{name: "right-most untrusted", remote: "10.0.0.5:5000", xff: []string{"1.2.3.4, 10.0.0.9"}, want: "1.2.3.4"},
		{name: "no header", remote: "10.0.0.5:5000", want: "10.0.0.5"},
		{name: "garbage", remote: "10.0.0.5:5000", xff: []string{"garbage"}, want: "10.0.0.5"},
		{name: "all trusted gives the left-most", remote: "10.0.0.5:5000", xff: []string{"10.0.0.7"}, want: "10.0.0.7"},
		{name: "spoofed left of the proxy's entry", remote: "10.0.0.5:5000", xff: []string{"6.6.6.6, 1.2.3.4"}, want: "1.2.3.4"},
		{name: "headers read as one list", remote: "10.0.0.5:5000", xff: []string{"1.2.3.4", "10.0.0.9"}, want: "1.2.3.4"},
		{name: "garbage stops the walk", remote: "10.0.0.5:5000", xff: []string{"1.2.3.4, garbage, 10.0.0.9"}, want: "10.0.0.9"},
		{name: "IPv4-mapped remote", remote: "[::ffff:10.0.0.5]:5000", xff: []string{"::ffff:1.2.3.4"}, want: "1.2.3.4"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := trusting.clientAddr(forwarded(tc.remote, tc.xff...)); got.String() != tc.want {
				t.Errorf("clientAddr(%s, X-Forwarded-For %q) = %v, want %s", tc.remote, tc.xff, got, tc.want)
			}
		})
	}
}

func TestWho(t *testing.T) {
	const id = "SESSIONIDSESSIONIDSESSIONID"
	withSession := func(id string) *http.Request {
		r := forwarded("192.0.2.1:1")
		r.AddCookie(cookieOptions{}.cookie(sessionCookie, id, r))
		return r
	}
	fp, _ := fields(trusting.who(withSession(id)))["session"].(string)
	if !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(fp) || strings.Contains(id, fp) {
		t.Errorf("who() session = %q, want 8 hex characters that are not the ID %q", fp, id)
	}
	if again := fields(trusting.who(withSession(id)))["session"]; again != fp {
		t.Errorf("who() session = %q, then %q, want the same fingerprint for the same ID", fp, again)
	}
	if other := fields(trusting.who(withSession(id + "2")))["session"]; other == fp {
		t.Errorf("who() session for two IDs = %q, want different fingerprints", fp)
	}

	tests := []struct {
		name string
		r    *http.Request
		want map[string]any
	}{
		{
			name: "direct",
			r:    forwarded("192.0.2.1:1", "1.2.3.4"),
			want: map[string]any{"session": "", "remote": "192.0.2.1"},
		},
		{
			name: "through a trusted proxy",
			r:    forwarded("10.0.0.5:1234", "1.2.3.4"),
			want: map[string]any{"session": "", "remote": "1.2.3.4", "proxy": "10.0.0.5:1234"},
		},
		{
			name: "trusted proxy without the header",
			r:    forwarded("10.0.0.5:1234"),
			want: map[string]any{"session": "", "remote": "10.0.0.5"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if diff := cmp.Diff(tc.want, fields(trusting.who(tc.r))); diff != "" {
				t.Errorf("who() mismatch (-want +got):\n%s", diff)
			}
		})
	}
}
