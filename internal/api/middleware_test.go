// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
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
	h := requireToken("s3cret", cookieOptions{Path: "/ldap/", Secure: true}, slog.New(slog.DiscardHandler), (&server{}).origin, okHandler)

	if got := serve(h, httptest.NewRequest(http.MethodGet, "/api/profiles", nil)).Code; got != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", got)
	}

	rec := serve(h, httptest.NewRequest(http.MethodGet, "/ldap/c/dev?token=s3cret&x=1", nil))
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/ldap/c/dev?x=1" {
		t.Errorf("login link = %d Location %q, want 303 to /ldap/c/dev?x=1", rec.Code, rec.Header().Get("Location"))
	}
	cookie := (&http.Response{Header: rec.Header()}).Cookies()
	if len(cookie) != 1 || cookie[0].Name != "ldaplens_token" || !cookie[0].HttpOnly || cookie[0].SameSite != http.SameSiteStrictMode ||
		cookie[0].Path != "/ldap/" || !cookie[0].Secure {
		t.Fatalf("login link cookies = %+v, want HttpOnly SameSite=Strict Secure ldaplens_token with Path /ldap/", cookie)
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
	wrongCookie.AddCookie(cookieOptions{}.cookie("ldaplens_token", "wrong", wrongCookie))
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

	if got := serve(requireToken("", cookieOptions{Path: "/"}, slog.New(slog.DiscardHandler), (&server{}).origin, okHandler), httptest.NewRequest(http.MethodGet, "/", nil)).Code; got != http.StatusOK {
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

// apiRequest is a GET under /api/ from session, or from no session when
// session is empty.
func apiRequest(ctx context.Context, session string) *http.Request {
	r := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/c/x/info", nil)
	if session != "" {
		r.Header.Set("Cookie", sessionCookie+"="+session)
	}
	return r
}

// blockingStub is a handler that holds every request until release is
// closed, after signalling started.
type blockingStub struct {
	started chan struct{}
	release chan struct{}
}

func newBlockingStub() *blockingStub {
	// Buffered, so that a request that runs late never blocks on it.
	return &blockingStub{started: make(chan struct{}, 64), release: make(chan struct{})}
}

func (s *blockingStub) ServeHTTP(http.ResponseWriter, *http.Request) {
	s.started <- struct{}{}
	<-s.release
}

// running reports whether one more request reached the handler in time.
func (s *blockingStub) running() bool {
	select {
	case <-s.started:
		return true
	case <-time.After(5 * time.Second):
		return false
	}
}

func TestAdmitQueues(t *testing.T) {
	var running atomic.Int32
	h := admit(64, 4, 10*time.Second, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		if n := running.Add(1); n > 4 {
			t.Errorf("%d requests of one session run at once, want at most 4", n)
		}
		time.Sleep(50 * time.Millisecond)
		running.Add(-1)
	}))
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			if rec := serve(h, apiRequest(t.Context(), "a")); rec.Code != http.StatusOK {
				t.Errorf("queued request = %d %s, want 200", rec.Code, rec.Body)
			}
		})
	}
	wg.Wait()
}

func TestAdmitBusy(t *testing.T) {
	stub := newBlockingStub()
	h := admit(64, 4, 20*time.Millisecond, stub)
	var wg sync.WaitGroup
	defer wg.Wait()
	defer close(stub.release)
	for range 4 {
		wg.Go(func() { serve(h, apiRequest(t.Context(), "a")) })
		if !stub.running() {
			t.Fatal("a request did not run")
		}
	}
	rec := serve(h, apiRequest(t.Context(), "a"))
	if rec.Code != http.StatusServiceUnavailable || errorCode(t, rec) != "busy" || rec.Header().Get("Retry-After") != "1" {
		t.Errorf("5th request of a session = %d %s Retry-After %q, want 503 busy, Retry-After 1", rec.Code, rec.Body, rec.Header().Get("Retry-After"))
	}
	wg.Go(func() { serve(h, apiRequest(t.Context(), "b")) })
	if !stub.running() {
		t.Error("a request of another session did not run")
	}
}

func TestAdmitGlobal(t *testing.T) {
	stub := newBlockingStub()
	h := admit(2, 4, 20*time.Millisecond, stub)
	var wg sync.WaitGroup
	defer wg.Wait()
	defer close(stub.release)
	for _, session := range []string{"a", ""} {
		wg.Go(func() { serve(h, apiRequest(t.Context(), session)) })
		if !stub.running() {
			t.Fatalf("request of session %q did not run", session)
		}
	}
	start := time.Now()
	rec := serve(h, apiRequest(t.Context(), "c"))
	if waited := time.Since(start); waited < 20*time.Millisecond {
		t.Errorf("3rd request waited %v, want at least 20ms", waited)
	}
	if rec.Code != http.StatusServiceUnavailable || errorCode(t, rec) != "busy" {
		t.Errorf("3rd request = %d %s, want 503 busy", rec.Code, rec.Body)
	}
	// The SPA is not queued.
	wg.Go(func() { serve(h, httptest.NewRequest(http.MethodGet, "/", nil)) })
	if !stub.running() {
		t.Error("GET / did not run while the API is full")
	}
}

func TestAdmitClientGone(t *testing.T) {
	stub := newBlockingStub()
	h := admit(64, 1, 10*time.Second, stub)
	var wg sync.WaitGroup
	defer wg.Wait()
	defer close(stub.release)
	wg.Go(func() { serve(h, apiRequest(t.Context(), "a")) })
	if !stub.running() {
		t.Fatal("the first request did not run")
	}
	ctx, cancel := context.WithCancel(t.Context())
	time.AfterFunc(20*time.Millisecond, cancel)
	start := time.Now()
	serve(h, apiRequest(ctx, "a"))
	if waited := time.Since(start); waited > 5*time.Second {
		t.Errorf("a queued request whose client went away returned after %v, want right away", waited)
	}
	if n := len(stub.started); n != 0 {
		t.Errorf("the handler ran %d times for a request whose client went away, want 0", n)
	}
}

func TestSessionSlotsForget(t *testing.T) {
	q := newSessionSlots(4)
	first, second := q.join("a"), q.join("a")
	if first != second {
		t.Error("join(a) twice gave two semaphores, want one")
	}
	q.leave("a")
	if len(q.m) != 1 {
		t.Errorf("sessions after one of two leave = %d, want 1", len(q.m))
	}
	q.leave("a")
	if len(q.m) != 0 {
		t.Errorf("sessions after both leave = %d, want 0", len(q.m))
	}
}

func TestWithDeadline(t *testing.T) {
	tests := []struct {
		path string
		want time.Duration // 0: no deadline
	}{
		{path: "/api/c/x/search", want: 2 * time.Minute},
		{path: "/api/c/x/changes/apply", want: 4 * time.Minute},
		{path: "/", want: 0},
	}
	for _, tc := range tests {
		var left time.Duration
		var ok bool
		h := withDeadline(2*time.Minute, 4*time.Minute, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			var d time.Time
			d, ok = r.Context().Deadline()
			left = time.Until(d)
		}))
		serve(h, httptest.NewRequest(http.MethodPost, tc.path, nil))
		switch {
		case tc.want == 0 && ok:
			t.Errorf("withDeadline(POST %s) set a deadline %v ahead, want none", tc.path, left)
		case tc.want != 0 && (!ok || left > tc.want || left < tc.want-10*time.Second):
			t.Errorf("withDeadline(POST %s) deadline %v ahead (set %v), want about %v", tc.path, left, ok, tc.want)
		}
	}
}
