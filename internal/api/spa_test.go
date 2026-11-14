// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

func TestSPAHandler(t *testing.T) {
	ui := fstest.MapFS{
		"index.html":    {Data: []byte(`<html><head><base href="/"></head><body>app</body></html>`)},
		"assets/app.js": {Data: []byte(`console.log(1)`)},
	}
	tests := []struct {
		name     string
		base     string
		path     string
		want     int
		wantBody string
	}{
		{name: "root", path: "/", want: http.StatusOK, wantBody: `<base href="/">`},
		{name: "client route", path: "/c/dev/entry", want: http.StatusOK, wantBody: "app"},
		{name: "asset", path: "/assets/app.js", want: http.StatusOK, wantBody: "console.log(1)"},
		{name: "unknown api", path: "/api/nope", want: http.StatusNotFound, wantBody: `"code":"not_found"`},
		{name: "base path rewrite", base: "/ldap", path: "/", want: http.StatusOK, wantBody: `<base href="/ldap/">`},
	}
	for _, tc := range tests {
		rec := httptest.NewRecorder()
		spaHandler(ui, tc.base).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != tc.want || !strings.Contains(rec.Body.String(), tc.wantBody) {
			t.Errorf("%s: GET %s = %d %q, want %d containing %q", tc.name, tc.path, rec.Code, rec.Body, tc.want, tc.wantBody)
		}
	}
}

func TestSPAHandlerNotBuilt(t *testing.T) {
	for _, ui := range []fstest.MapFS{nil, {".keep": {}}} {
		rec := httptest.NewRecorder()
		spaHandler(ui, "").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("GET / without index.html = %d, want 503", rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	spaHandler(nil, "").ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST / = %d, want 405", rec.Code)
	}
}

func TestSPAAssets(t *testing.T) {
	js := strings.Repeat("console.log('ldapui');\n", 200)
	ui := fstest.MapFS{
		"index.html":       {Data: []byte(`<html><head><base href="/"></head></html>`)},
		"assets/app-1.js":  {Data: []byte(js)},
		"assets/tiny-1.js": {Data: []byte("x")},
		"assets/app-1.map": {Data: []byte(strings.Repeat(`{"mappings":"AAAA"}`, 100))},
	}
	h := spaHandler(ui, "")
	get := func(method, path, accept string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		if accept != "" {
			r.Header.Set("Accept-Encoding", accept)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec
	}

	t.Run("gzip when accepted", func(t *testing.T) {
		rec := get(http.MethodGet, "/assets/app-1.js", "br, gzip")
		if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("Content-Encoding = %q, want gzip", got)
		}
		if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
			t.Errorf("Vary = %q, want Accept-Encoding", got)
		}
		if got, want := rec.Header().Get("Cache-Control"), "private, max-age=31536000, immutable"; got != want {
			t.Errorf("Cache-Control = %q, want %q", got, want)
		}
		if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/javascript") {
			t.Errorf("Content-Type = %q, want text/javascript", got)
		}
		if got := rec.Header().Get("Content-Length"); got != strconv.Itoa(rec.Body.Len()) {
			t.Errorf("Content-Length = %q, body is %d bytes", got, rec.Body.Len())
		}
		zr, err := gzip.NewReader(bytes.NewReader(rec.Body.Bytes()))
		if err != nil {
			t.Fatalf("gzip.NewReader() error = %v", err)
		}
		body, err := io.ReadAll(zr)
		if err != nil || string(body) != js {
			t.Errorf("decompressed body = %d bytes, err %v, want the original %d bytes", len(body), err, len(js))
		}
	})

	t.Run("identity without gzip", func(t *testing.T) {
		for _, accept := range []string{"", "br", "gzip;q=0", "*;q=0"} {
			rec := get(http.MethodGet, "/assets/app-1.js", accept)
			if rec.Header().Get("Content-Encoding") != "" || rec.Body.String() != js {
				t.Errorf("Accept-Encoding %q: got encoding %q and %d bytes, want identity", accept, rec.Header().Get("Content-Encoding"), rec.Body.Len())
			}
			if got, want := rec.Header().Get("Cache-Control"), "private, max-age=31536000, immutable"; got != want {
				t.Errorf("Accept-Encoding %q: Cache-Control = %q, want %q", accept, got, want)
			}
		}
	})

	t.Run("head has no body", func(t *testing.T) {
		rec := get(http.MethodHead, "/assets/app-1.js", "gzip")
		if rec.Header().Get("Content-Encoding") != "gzip" || rec.Body.Len() != 0 {
			t.Errorf("HEAD = encoding %q, %d body bytes; want gzip and none", rec.Header().Get("Content-Encoding"), rec.Body.Len())
		}
	})

	t.Run("gzip keeps the identity content type", func(t *testing.T) {
		// .map has no type in Go's builtin table; the gzip bytes must not be
		// sniffed as application/x-gzip.
		identity := get(http.MethodGet, "/assets/app-1.map", "")
		gz := get(http.MethodGet, "/assets/app-1.map", "gzip")
		if gz.Header().Get("Content-Encoding") != "gzip" {
			t.Fatalf("Content-Encoding = %q, want gzip", gz.Header().Get("Content-Encoding"))
		}
		if got, want := gz.Header().Get("Content-Type"), identity.Header().Get("Content-Type"); got != want {
			t.Errorf("gzip Content-Type = %q, want the identity %q", got, want)
		}
	})

	t.Run("incompressible stays identity", func(t *testing.T) {
		rec := get(http.MethodGet, "/assets/tiny-1.js", "gzip")
		if rec.Header().Get("Content-Encoding") != "" || rec.Body.String() != "x" {
			t.Errorf("tiny asset = encoding %q body %q, want identity x", rec.Header().Get("Content-Encoding"), rec.Body)
		}
	})

	t.Run("missing asset is 404", func(t *testing.T) {
		rec := get(http.MethodGet, "/assets/gone-2.js", "gzip")
		if rec.Code != http.StatusNotFound || rec.Header().Get("Cache-Control") != "" {
			t.Errorf("missing asset = %d, Cache-Control %q; want 404 and none", rec.Code, rec.Header().Get("Cache-Control"))
		}
	})

	t.Run("index stays uncached", func(t *testing.T) {
		rec := get(http.MethodGet, "/c/demo/entry", "gzip")
		if rec.Header().Get("Cache-Control") != "no-cache" || rec.Header().Get("Content-Encoding") != "" {
			t.Errorf("index = Cache-Control %q, encoding %q; want no-cache, identity", rec.Header().Get("Cache-Control"), rec.Header().Get("Content-Encoding"))
		}
	})
}

func TestAcceptsGzip(t *testing.T) {
	tests := []struct {
		header string
		want   bool
	}{
		{header: "", want: false},
		{header: "gzip", want: true},
		{header: "GZIP", want: true},
		{header: "deflate, gzip;q=0.5", want: true},
		{header: "gzip;q=0", want: false},
		{header: "gzip; q=0.0", want: false},
		{header: "*", want: true},
		{header: "*;q=0", want: false},
		{header: "*;q=0, gzip", want: true},
		{header: "gzip;q=0, *", want: false},
		{header: "br", want: false},
	}
	for _, tc := range tests {
		if got := acceptsGzip(tc.header); got != tc.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", tc.header, got, tc.want)
		}
	}
}
