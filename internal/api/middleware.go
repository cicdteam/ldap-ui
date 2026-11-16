// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"context"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const tokenCookie = "ldaplens_token" //nolint:gosec // cookie name, not a credential

// contentSecurityPolicy allows only this origin, plus data: images (photos
// and the favicon) and inline styles, which CodeMirror and the dialogs'
// scroll lock inject as <style> elements.
const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
	"font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"

// cookieOptions scopes the cookies the server sets.
type cookieOptions struct {
	// Path is the base path plus "/", or "/" without a base path, so the
	// cookie is not sent to other apps on the same host.
	Path string
	// Secure marks cookies Secure on plain-HTTP requests too, for a UI
	// served over HTTPS by a TLS-terminating proxy or ingress.
	Secure bool
}

// cookie returns an HttpOnly, SameSite=Strict cookie scoped by o. It is
// Secure when o says so or when r came in over TLS.
func (o cookieOptions) cookie(name, value string, r *http.Request) *http.Cookie {
	return &http.Cookie{ //nolint:gosec // Secure is off only for plain HTTP, which must keep working on loopback
		Name: name, Value: value, Path: o.Path,
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: o.Secure || r.TLS != nil,
	}
}

// securityHeaders sets the CSP, anti-framing, nosniff and referrer headers on
// every response, and no-store on responses under base+"/api", which carry
// directory data. They are set before next runs, so error responses and
// redirects carry them too; a handler may still override Cache-Control.
func securityHeaders(base string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		// URLs carry DNs and filters.
		h.Set("Referrer-Policy", "no-referrer")
		if p, ok := strings.CutPrefix(r.URL.Path, base); ok && (p == "/api" || strings.HasPrefix(p, "/api/")) {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// hostCheck rejects requests whose Host header is not localhost or one of
// extra. This defeats DNS rebinding: a malicious site cannot reach the API
// through a hostname that resolves to 127.0.0.1.
func hostCheck(extra []string, next http.Handler) http.Handler {
	allowed := map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}
	for _, h := range extra {
		allowed[strings.ToLower(h)] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.ToLower(strings.Trim(host, "[]"))
		if !allowed[host] {
			writeError(w, http.StatusForbidden, apiError{
				Code:    "host_not_allowed",
				Message: fmt.Sprintf("host %q is not allowed; add it with --allowed-hosts", host),
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireToken admits requests carrying token as the ldaplens_token cookie or
// as a bearer token. A GET with ?token= sets the cookie and redirects to the
// same URL without it, so the login link printed at startup just works. An
// empty token disables the check. A refusal logs "auth failed" with
// origin(r), never the token it presented.
func requireToken(token string, cookies cookieOptions, log *slog.Logger, origin func(*http.Request) []any, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	valid := func(s string) bool { return subtle.ConstantTimeCompare([]byte(s), []byte(token)) == 1 }
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if q := r.URL.Query().Get("token"); q != "" && r.Method == http.MethodGet && valid(q) {
			http.SetCookie(w, cookies.cookie(tokenCookie, token, r))
			http.Redirect(w, r, withoutToken(r.RequestURI), http.StatusSeeOther) //nolint:gosec // withoutToken returns a local path
			return
		}
		if c, err := r.Cookie(tokenCookie); err == nil && valid(c.Value) {
			next.ServeHTTP(w, r)
			return
		}
		if b, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok && valid(b) {
			next.ServeHTTP(w, r)
			return
		}
		log.Info("auth failed", origin(r)...)
		writeError(w, http.StatusUnauthorized, apiError{Code: "unauthorized", Message: "open the login link printed in the server log"})
	})
}

// withoutToken drops the token parameter from a request URI. It uses the
// raw RequestURI because a base-path prefix may already be stripped from
// r.URL.Path. Anything but a local path (an absolute-form target, or one
// starting with "//" that a browser reads as another host) becomes "/".
func withoutToken(requestURI string) string {
	u, err := url.ParseRequestURI(requestURI)
	if err != nil {
		return "/"
	}
	q := u.Query()
	q.Del("token")
	u.RawQuery = q.Encode()
	s := u.String()
	if !strings.HasPrefix(s, "/") || strings.HasPrefix(s, "//") {
		return "/"
	}
	return s
}

// requireJSON rejects state-changing requests that are not
// application/json. Browsers cannot send JSON cross-site without a CORS
// preflight, so this backs up the CSRF protection.
func requireJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if mt != "application/json" {
				writeError(w, http.StatusUnsupportedMediaType, apiError{Code: "unsupported_media_type", Message: "request body must be application/json"})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// withBasePath serves h under base (like "/ldap"), for running behind a
// reverse proxy or ingress on a sub-path. An empty base returns h.
func withBasePath(base string, h http.Handler) http.Handler {
	if base == "" {
		return h
	}
	mux := http.NewServeMux()
	mux.Handle(base+"/", http.StripPrefix(base, h))
	// Keep the query: login links and reconnect targets point at the bare base.
	mux.HandleFunc(base, func(w http.ResponseWriter, r *http.Request) {
		target := base + "/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusMovedPermanently) //nolint:gosec // the path is always base+"/"; the query cannot change it
	})
	return mux
}

// admit queues requests under /api/: at most global run at once
// server-wide, and at most perSession with one session cookie. A request
// without the cookie, like a first connect, takes only a global slot. One
// that waits longer than wait in all gets 503 busy with Retry-After: 1.
func admit(global, perSession int, wait time.Duration, next http.Handler) http.Handler {
	all := make(chan struct{}, global)
	sessions := newSessionSlots(perSession)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		expired := time.After(wait)
		// The session slot comes first, so that a session's queued requests
		// hold no global slot.
		if c, err := r.Cookie(sessionCookie); err == nil {
			sem := sessions.join(c.Value)
			defer sessions.leave(c.Value)
			if !acquire(w, r, sem, expired) {
				return
			}
			defer func() { <-sem }()
		}
		if !acquire(w, r, all, expired) {
			return
		}
		defer func() { <-all }()
		next.ServeHTTP(w, r)
	})
}

// acquire takes a slot of sem. It writes 503 busy when expired fires first,
// and the cancellation when the client goes away first; that write fails if
// the client is gone.
func acquire(w http.ResponseWriter, r *http.Request, sem chan<- struct{}, expired <-chan time.Time) bool {
	select {
	case sem <- struct{}{}:
		return true
	case <-expired:
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusServiceUnavailable, apiError{Code: "busy", Message: "too many requests at once; try again"})
	case <-r.Context().Done():
		status, body := errorResponse(r.Context().Err())
		writeError(w, status, body)
	}
	return false
}

// sessionSlots holds a semaphore for each session cookie value with a
// request running or waiting.
type sessionSlots struct {
	size int
	mu   sync.Mutex
	m    map[string]*sessionSlot
}

type sessionSlot struct {
	sem   chan struct{}
	users int
}

func newSessionSlots(size int) *sessionSlots {
	return &sessionSlots{size: size, m: make(map[string]*sessionSlot)}
}

// join returns id's semaphore. Every join needs a leave.
func (q *sessionSlots) join(id string) chan struct{} {
	q.mu.Lock()
	defer q.mu.Unlock()
	s := q.m[id]
	if s == nil {
		s = &sessionSlot{sem: make(chan struct{}, q.size)}
		q.m[id] = s
	}
	s.users++
	return s.sem
}

// leave drops id's semaphore after its last user.
func (q *sessionSlots) leave(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	s := q.m[id]
	s.users--
	if s.users == 0 {
		delete(q.m, id)
	}
}

// withDeadline bounds requests under /api/ to read, and changes/apply, which
// writes entry after entry, to apply.
func withDeadline(read, apply time.Duration, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		d := read
		if strings.HasSuffix(r.URL.Path, "/changes/apply") {
			d = apply
		}
		ctx, cancel := context.WithTimeout(r.Context(), d)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
