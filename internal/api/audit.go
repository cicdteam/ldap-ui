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
	fp := ""
	if id := sessionID(r); id != "" {
		sum := sha256.Sum256([]byte(id))
		fp = hex.EncodeToString(sum[:4])
	}
	kv := []any{"session", fp, "remote", r.RemoteAddr}
	if s.identityHeader == "" || !s.trusted(r.RemoteAddr) {
		return kv
	}
	user := r.Header.Get(s.identityHeader)
	if len(user) > maxUser {
		user = user[:maxUser]
	}
	return append(kv, "user", user)
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
