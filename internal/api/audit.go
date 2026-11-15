// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/netip"
	"slices"

	"github.com/cicdteam/ldap-ui/internal/profile"
)

// maxUser bounds the identity header value in a log line, in bytes.
const maxUser = 256

// who identifies the caller in logs: "session", a fingerprint of the session
// cookie ("" without one), never the ID itself; "remote", the client address
// (behind a proxy, the proxy's: match it with the proxy's access log); and
// "user", the IdentityHeader value, only on a request from TrustedProxies.
func (s *server) who(r *http.Request) []any {
	kv := []any{"session", fingerprint(sessionID(r)), "remote", r.RemoteAddr}
	user, ok := s.identity(r)
	if !ok {
		return kv
	}
	if len(user) > maxUser {
		user = user[:maxUser]
	}
	return append(kv, "user", user)
}

// identity is the IdentityHeader value of a request from TrustedProxies,
// empty when the proxy sent none. ok is false without IdentityHeader and for
// every other request, whose header proves nothing.
func (s *server) identity(r *http.Request) (user string, ok bool) {
	if s.identityHeader == "" || !s.trusted(r.RemoteAddr) {
		return "", false
	}
	return r.Header.Get(s.identityHeader), true
}

// fingerprint is the first 8 hex characters of the SHA-256 of a session ID,
// or "" for no ID.
func fingerprint(id string) string {
	if id == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:4])
}

// trusted reports whether remote, a request's RemoteAddr, is in one of the
// trusted proxy prefixes.
func (s *server) trusted(remote string) bool {
	ap, err := netip.ParseAddrPort(remote)
	if err != nil {
		return false
	}
	ip := ap.Addr().Unmap() // a dual-stack listener may report IPv4 as ::ffff:a.b.c.d
	return slices.ContainsFunc(s.trustedProxies, func(p netip.Prefix) bool { return p.Contains(ip) })
}

// attributed is kv followed by the bind DN and who(r), the fields every
// connect and write line ends with. They go last so that the fields before
// them keep their order.
func (s *server) attributed(r *http.Request, p profile.Profile, kv ...any) []any {
	return slices.Concat(kv, []any{"bindDN", p.BindDN}, s.who(r))
}
