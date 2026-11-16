// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/netip"
	"slices"
	"strings"

	"github.com/cicdteam/ldaplens/internal/profile"
)

// who identifies the caller in logs: "session", a fingerprint of the session
// cookie ("" without one), never the ID itself, followed by origin(r).
func (s *server) who(r *http.Request) []any {
	return append([]any{"session", fingerprint(sessionID(r))}, s.origin(r)...)
}

// origin is where a request came from, as logs carry it: "remote", the
// client address (see clientAddr), and "proxy", the RemoteAddr the request
// came through, only when that is not the client.
func (s *server) origin(r *http.Request) []any {
	client := s.clientAddr(r)
	kv := []any{"remote", client.String()}
	if remote, _ := netip.ParseAddrPort(r.RemoteAddr); remote.Addr().Unmap() != client {
		kv = append(kv, "proxy", r.RemoteAddr)
	}
	return kv
}

// clientAddr is the address of the client that sent r. For a request from
// one of the trusted proxies, it is the right-most X-Forwarded-For address
// that is not itself a trusted proxy, or the left-most one when all are;
// an entry that does not parse ends the walk, as nothing left of it can be
// told apart from what the client sent. For any other request, and when
// there is no X-Forwarded-For, it is RemoteAddr's host.
//
// ponytail: an entry with a port, as some proxies write them, ends the
// walk too; parse it as an AddrPort if such a proxy is in front.
func (s *server) clientAddr(r *http.Request) netip.Addr {
	remote, _ := netip.ParseAddrPort(r.RemoteAddr) // the listener is TCP, so it parses
	client := remote.Addr().Unmap()                // a dual-stack listener may report IPv4 as ::ffff:a.b.c.d
	if !s.trusted(client) {
		return client
	}
	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for _, hop := range slices.Backward(hops) {
		ip, err := netip.ParseAddr(strings.TrimSpace(hop))
		if err != nil {
			break
		}
		client = ip.Unmap()
		if !s.trusted(client) {
			break
		}
	}
	return client
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

// trusted reports whether ip is in one of the trusted proxy prefixes.
func (s *server) trusted(ip netip.Addr) bool {
	return slices.ContainsFunc(s.trustedProxies, func(p netip.Prefix) bool { return p.Contains(ip) })
}

// attributed is kv followed by the bind DN and who(r), the fields every
// connect and write line ends with. They go last so that the fields before
// them keep their order.
func (s *server) attributed(r *http.Request, p profile.Profile, kv ...any) []any {
	return slices.Concat(kv, []any{"bindDN", p.BindDN}, s.who(r))
}
