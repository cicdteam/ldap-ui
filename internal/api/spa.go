// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// assetsPrefix is where Vite writes content-hashed files: a name never
// changes content, so browsers may cache them for good.
const assetsPrefix = "assets/"

// immutable is private: the UI sits behind the access token, so shared
// caches must not keep it.
const immutable = "private, max-age=31536000, immutable"

// compressible lists the asset types worth gzipping; images and fonts are
// compressed already.
var compressible = map[string]bool{".js": true, ".css": true, ".svg": true, ".json": true, ".map": true, ".txt": true}

// spaHandler serves the built UI. Paths that are not files fall back to
// index.html so client-side routes work on reload. The <base href="/"> in
// index.html is rewritten to the base path so assets load under a sub-path.
// Files under assets/ are content-hashed, so they are cached for a year,
// served gzipped (compressed once here) to clients that accept it, and a
// missing one is a 404 rather than index.html. index.html itself stays
// no-cache and uncompressed.
func spaHandler(fsys fs.FS, basePath string) http.Handler {
	gzipped := gzipAssets(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, apiError{Code: "method_not_allowed", Message: r.Method + " is not allowed here"})
			return
		}
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "api" || strings.HasPrefix(p, "api/") {
			writeError(w, http.StatusNotFound, apiError{Code: "not_found", Message: "no such API endpoint"})
			return
		}
		if fsys == nil {
			http.Error(w, "web UI is not built; run make web", http.StatusServiceUnavailable)
			return
		}
		if p != "" && p != "index.html" {
			if st, err := fs.Stat(fsys, p); err == nil && !st.IsDir() {
				if strings.HasPrefix(p, assetsPrefix) {
					serveAsset(w, r, fsys, p, gzipped[p])
					return
				}
				http.ServeFileFS(w, r, fsys, p)
				return
			}
			// A stale hashed asset after an upgrade must fail loudly, not
			// receive index.html as JavaScript.
			if strings.HasPrefix(p, assetsPrefix) {
				http.NotFound(w, r)
				return
			}
		}
		index, err := fs.ReadFile(fsys, "index.html")
		if err != nil {
			http.Error(w, "web UI is not built; run make web", http.StatusServiceUnavailable)
			return
		}
		index = bytes.Replace(index, []byte(`<base href="/">`), []byte(`<base href="`+basePath+`/">`), 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(index)
	})
}

// serveAsset serves a content-hashed file with a permanent cache lifetime,
// gzipped when gz is set and the client accepts it.
func serveAsset(w http.ResponseWriter, r *http.Request, fsys fs.FS, p string, gz []byte) {
	w.Header().Set("Cache-Control", immutable)
	if gz == nil {
		http.ServeFileFS(w, r, fsys, p)
		return
	}
	w.Header().Add("Vary", "Accept-Encoding")
	if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
		http.ServeFileFS(w, r, fsys, p)
		return
	}
	ct := mime.TypeByExtension(path.Ext(p))
	if ct == "" {
		// Every compressible type is text; left unset, net/http would sniff
		// the gzip bytes as application/x-gzip.
		ct = "text/plain; charset=utf-8"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Content-Length", strconv.Itoa(len(gz)))
	if r.Method != http.MethodHead {
		_, _ = w.Write(gz)
	}
}

// gzipAssets compresses the compressible files under assets/ once, keeping
// only those that get smaller.
func gzipAssets(fsys fs.FS) map[string][]byte {
	out := map[string][]byte{}
	if fsys == nil {
		return out
	}
	_ = fs.WalkDir(fsys, "assets", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !compressible[path.Ext(p)] {
			return nil // a missing assets/ directory just means nothing to compress
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return nil
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression) // the level is valid
		_, _ = zw.Write(data)                                    // bytes.Buffer writes cannot fail
		_ = zw.Close()
		if buf.Len() < len(data) {
			out[p] = buf.Bytes()
		}
		return nil
	})
	return out
}

// acceptsGzip reports whether an Accept-Encoding header allows gzip. An
// explicit gzip entry wins over "*"; q=0 refuses.
func acceptsGzip(header string) bool {
	gzipQ, starQ := -1.0, -1.0
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(part, ";")
		q := 1.0
		if v, ok := strings.CutPrefix(strings.TrimSpace(params), "q="); ok {
			if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
				q = f
			}
		}
		switch name = strings.TrimSpace(name); {
		case strings.EqualFold(name, "gzip"):
			gzipQ = q
		case name == "*":
			starQ = q
		}
	}
	if gzipQ >= 0 {
		return gzipQ > 0
	}
	return starQ > 0
}
