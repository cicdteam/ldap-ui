// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

var okHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

func serve(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func TestHostCheck(t *testing.T) {
	h := hostCheck([]string{"ldap.example.com"}, okHandler)
	tests := []struct {
		host string
		want int
	}{
		{host: "localhost:8080", want: http.StatusOK},
		{host: "127.0.0.1:8080", want: http.StatusOK},
		{host: "[::1]:8080", want: http.StatusOK},
		{host: "LDAP.example.com", want: http.StatusOK},
		{host: "evil.example.com:8080", want: http.StatusForbidden},
		{host: "10.0.0.5:8080", want: http.StatusForbidden},
	}
	for _, tc := range tests {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Host = tc.host
		if got := serve(h, r).Code; got != tc.want {
			t.Errorf("hostCheck(Host %q) = %d, want %d", tc.host, got, tc.want)
		}
	}
}

func TestRequireToken(t *testing.T) {
	h := requireToken("s3cret", cookieOptions{Path: "/ldap/", Secure: true}, okHandler)

	if got := serve(h, httptest.NewRequest(http.MethodGet, "/api/profiles", nil)).Code; got != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", got)
	}

	rec := serve(h, httptest.NewRequest(http.MethodGet, "/ldap/c/dev?token=s3cret&x=1", nil))
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/ldap/c/dev?x=1" {
		t.Errorf("login link = %d Location %q, want 303 to /ldap/c/dev?x=1", rec.Code, rec.Header().Get("Location"))
	}
	cookie := (&http.Response{Header: rec.Header()}).Cookies()
	if len(cookie) != 1 || cookie[0].Name != "ldapui_token" || !cookie[0].HttpOnly || cookie[0].SameSite != http.SameSiteStrictMode ||
		cookie[0].Path != "/ldap/" || !cookie[0].Secure {
		t.Fatalf("login link cookies = %+v, want HttpOnly SameSite=Strict Secure ldapui_token with Path /ldap/", cookie)
	}

	// The redirect must stay on this site even for a protocol-relative or
	// absolute-form request target.
	for _, target := range []string{"//evil.example.com/x?token=s3cret", "http://evil.example.com/x?token=s3cret"} {
		if got := serve(h, httptest.NewRequest(http.MethodGet, target, nil)).Header().Get("Location"); got != "/" {
			t.Errorf("login link %q redirects to %q, want /", target, got)
		}
	}

	r := httptest.NewRequest(http.MethodGet, "/api/profiles", nil)
	r.AddCookie(cookie[0])
	if got := serve(h, r).Code; got != http.StatusOK {
		t.Errorf("with cookie = %d, want 200", got)
	}

	r = httptest.NewRequest(http.MethodGet, "/api/profiles", nil)
	r.Header.Set("Authorization", "Bearer s3cret")
	if got := serve(h, r).Code; got != http.StatusOK {
		t.Errorf("with bearer = %d, want 200", got)
	}

	wrongCookie := httptest.NewRequest(http.MethodGet, "/api/profiles", nil)
	wrongCookie.AddCookie(cookieOptions{}.cookie("ldapui_token", "wrong", wrongCookie))
	wrongBearer := httptest.NewRequest(http.MethodGet, "/api/profiles", nil)
	wrongBearer.Header.Set("Authorization", "Bearer wrong")
	for name, r := range map[string]*http.Request{
		"wrong query token": httptest.NewRequest(http.MethodGet, "/api/profiles?token=wrong", nil),
		"wrong cookie":      wrongCookie,
		"wrong bearer":      wrongBearer,
		// The query token is only a GET login link.
		"POST with query token": httptest.NewRequest(http.MethodPost, "/?token=s3cret", nil),
	} {
		if got := serve(h, r).Code; got != http.StatusUnauthorized {
			t.Errorf("%s = %d, want 401", name, got)
		}
	}

	if got := serve(requireToken("", cookieOptions{Path: "/"}, okHandler), httptest.NewRequest(http.MethodGet, "/", nil)).Code; got != http.StatusOK {
		t.Errorf("no token configured = %d, want 200", got)
	}
}

func TestCookieOptionsCookie(t *testing.T) {
	plain := httptest.NewRequest(http.MethodGet, "/", nil)
	direct := httptest.NewRequest(http.MethodGet, "https://localhost/", nil)
	tests := []struct {
		name       string
		opts       cookieOptions
		r          *http.Request
		wantSecure bool
	}{
		{name: "plain HTTP", opts: cookieOptions{Path: "/ldap/"}, r: plain, wantSecure: false},
		{name: "HTTPS ingress", opts: cookieOptions{Path: "/ldap/", Secure: true}, r: plain, wantSecure: true},
		{name: "direct TLS", opts: cookieOptions{Path: "/ldap/"}, r: direct, wantSecure: true},
	}
	for _, tc := range tests {
		c := tc.opts.cookie("n", "v", tc.r)
		if c.Name != "n" || c.Value != "v" || c.Path != "/ldap/" || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Secure != tc.wantSecure {
			t.Errorf("%s: cookie() = %+v, want n=v Path /ldap/ HttpOnly SameSite=Strict Secure %t", tc.name, c, tc.wantSecure)
		}
	}
}

func TestRequireJSON(t *testing.T) {
	h := requireJSON(okHandler)
	tests := []struct {
		method, contentType string
		want                int
	}{
		{method: http.MethodGet, want: http.StatusOK},
		{method: http.MethodPost, contentType: "application/json", want: http.StatusOK},
		{method: http.MethodPost, contentType: "application/json; charset=utf-8", want: http.StatusOK},
		{method: http.MethodPost, contentType: "text/plain", want: http.StatusUnsupportedMediaType},
		{method: http.MethodPost, want: http.StatusUnsupportedMediaType},
	}
	for _, tc := range tests {
		r := httptest.NewRequest(tc.method, "/api/connect", strings.NewReader("{}"))
		if tc.contentType != "" {
			r.Header.Set("Content-Type", tc.contentType)
		}
		if got := serve(h, r).Code; got != tc.want {
			t.Errorf("requireJSON(%s %q) = %d, want %d", tc.method, tc.contentType, got, tc.want)
		}
	}
}

func TestWithBasePath(t *testing.T) {
	inner := http.NewServeMux()
	inner.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	h := withBasePath("/ldap", inner)
	tests := []struct {
		path     string
		want     int
		location string
	}{
		{path: "/ldap/healthz", want: http.StatusOK},
		{path: "/healthz", want: http.StatusNotFound},
		{path: "/ldap", want: http.StatusMovedPermanently, location: "/ldap/"},
		// The SPA links to the base without a slash; a login token or a
		// reconnect target must survive the redirect.
		{path: "/ldap?token=t&next=%2Fc%2Fdev", want: http.StatusMovedPermanently, location: "/ldap/?token=t&next=%2Fc%2Fdev"},
	}
	for _, tc := range tests {
		rec := serve(h, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != tc.want || rec.Header().Get("Location") != tc.location {
			t.Errorf("withBasePath GET %s = %d Location %q, want %d Location %q", tc.path, rec.Code, rec.Header().Get("Location"), tc.want, tc.location)
		}
	}
	if withBasePath("", inner) != http.Handler(inner) {
		t.Error("withBasePath(\"\") wrapped the handler, want it unchanged")
	}
}

func TestSecurityHeaders(t *testing.T) {
	const wantCSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
		"font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
	ui := fstest.MapFS{
		"index.html":    {Data: []byte(`<html><head><base href="/"></head><body>app</body></html>`)},
		"assets/app.js": {Data: []byte(`console.log(1)`)},
	}
	type request struct {
		name, path, host string
		wantCode         int
		wantCache        string
	}
	for _, base := range []string{"", "/ldap"} {
		env := newTestEnvWith(t, Options{BasePath: base, UI: ui})
		requests := []request{
			{name: "index", path: "/", wantCode: http.StatusOK, wantCache: "no-cache"},
			{name: "asset", path: "/assets/app.js", wantCode: http.StatusOK, wantCache: immutable},
			{name: "api", path: "/api/profiles", wantCode: http.StatusOK, wantCache: "no-store"},
			{name: "unknown api", path: "/api/nope", wantCode: http.StatusNotFound, wantCache: "no-store"},
			{name: "probe", path: "/healthz", wantCode: http.StatusOK},
			{name: "host rejected", path: "/api/profiles", host: "evil.example.com", wantCode: http.StatusForbidden, wantCache: "no-store"},
		}
		if base != "" {
			requests = append(requests, request{name: "bare base redirect", wantCode: http.StatusMovedPermanently})
		}
		for _, tc := range requests {
			r := httptest.NewRequest(http.MethodGet, base+tc.path, nil)
			r.Host = "localhost:8080"
			if tc.host != "" {
				r.Host = tc.host
			}
			// The headers as sent with the status line, not the recorder's live map.
			res := serve(env.h, r).Result()
			if res.StatusCode != tc.wantCode {
				t.Errorf("base %q %s: GET %s = %d, want %d", base, tc.name, r.URL, res.StatusCode, tc.wantCode)
			}
			for name, want := range map[string]string{
				"Content-Security-Policy": wantCSP,
				"X-Frame-Options":         "DENY",
				"X-Content-Type-Options":  "nosniff",
				"Referrer-Policy":         "no-referrer",
				"Cache-Control":           tc.wantCache,
			} {
				if got := res.Header.Get(name); got != want {
					t.Errorf("base %q %s: GET %s header %s = %q, want %q", base, tc.name, r.URL, name, got, want)
				}
			}
		}
	}
}
