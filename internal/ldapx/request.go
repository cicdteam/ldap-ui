// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"errors"
	"fmt"

	ber "github.com/go-asn1-ber/asn1-ber"
	"github.com/go-ldap/ldap/v3"

	"github.com/cicdteam/ldaplens/internal/schema"
)

// Search scopes accepted in SearchRequest.Scope. Empty means ScopeSub.
const (
	ScopeBase = "base"
	ScopeOne  = "one"
	ScopeSub  = "sub"
)

const (
	defaultPageSize = 500
	maxPageSize     = 5000

	// go-ldap compiles filters recursively and slows down sharply on deep
	// nesting, so filters are capped before they reach it.
	maxFilterLength = 16 << 10
	maxFilterDepth  = 64
)

// ErrInvalidRequest marks search parameters rejected before reaching the server.
var ErrInvalidRequest = errors.New("invalid request")

// ErrSecretFilter marks a filter that matches on the value of a secret
// attribute: its results would let a search guess the secret.
var ErrSecretFilter = errors.New("filter tests a secret attribute")

// SearchRequest describes one page of a search. Cursor is Page.Cursor from
// the previous page of the same search on the same Conn; the other fields
// must be repeated unchanged.
type SearchRequest struct {
	BaseDN     string   `json:"base"`
	Scope      string   `json:"scope"`
	Filter     string   `json:"filter"`
	Attributes []string `json:"attributes,omitempty"`
	PageSize   int      `json:"pageSize,omitempty"`
	Cursor     string   `json:"cursor,omitempty"`
	SizeLimit  int      `json:"sizeLimit,omitempty"`
}

// Page is one page of search results. Cursor is empty on the last page.
type Page struct {
	Entries []Entry `json:"entries"`
	Cursor  string  `json:"cursor,omitempty"`
	// Truncated is set when the server stopped early because of a size or
	// time limit, or the response passed maxResponseEntries entries or
	// maxResponseBytes value bytes; Entries holds what arrived before that.
	Truncated bool     `json:"truncated,omitempty"`
	Referrals []string `json:"referrals,omitempty"`
}

var scopes = map[string]int{
	"":        ldap.ScopeWholeSubtree,
	ScopeBase: ldap.ScopeBaseObject,
	ScopeOne:  ldap.ScopeSingleLevel,
	ScopeSub:  ldap.ScopeWholeSubtree,
}

// buildRequest validates r and turns it into a go-ldap request. Without
// server-side paging the page size becomes a size limit, so huge
// containers are cut off and reported as truncated instead of hanging.
func buildRequest(r SearchRequest, paging bool) (*ldap.SearchRequest, error) {
	scope, ok := scopes[r.Scope]
	if !ok {
		return nil, fmt.Errorf("%w: scope %q must be base, one or sub", ErrInvalidRequest, r.Scope)
	}
	if r.SizeLimit < 0 {
		return nil, fmt.Errorf("%w: sizeLimit must not be negative", ErrInvalidRequest)
	}
	filter := r.Filter
	if filter == "" {
		filter = "(objectClass=*)"
	}
	if len(filter) > maxFilterLength {
		return nil, fmt.Errorf("%w: filter is longer than %d bytes", ErrInvalidRequest, maxFilterLength)
	}
	if filterDepth(filter) > maxFilterDepth {
		return nil, fmt.Errorf("%w: filter nests deeper than %d levels", ErrInvalidRequest, maxFilterDepth)
	}
	if _, err := ldap.CompileFilter(filter); err != nil {
		return nil, err
	}
	size := r.PageSize
	if size <= 0 {
		size = defaultPageSize
	}
	size = min(size, maxPageSize)
	req := &ldap.SearchRequest{
		BaseDN:       r.BaseDN,
		Scope:        scope,
		DerefAliases: ldap.NeverDerefAliases,
		SizeLimit:    r.SizeLimit,
		Filter:       filter,
		Attributes:   r.Attributes,
	}
	if !paging {
		if r.Cursor != "" {
			return nil, fmt.Errorf("%w: the server does not support paging", ErrInvalidRequest)
		}
		if req.SizeLimit == 0 || req.SizeLimit > size {
			req.SizeLimit = size
		}
		return req, nil
	}
	// The cookie for r.Cursor is set by Conn.Search, which keeps it.
	req.Controls = []ldap.Control{ldap.NewControlPaging(uint32(size))} //nolint:gosec // size is clamped to maxPageSize
	return req, nil
}

// filterDepth returns the deepest parenthesis nesting in f. RFC 4515
// requires parentheses inside values to be escaped as \28 and \29, so every
// raw parenthesis is structural.
func filterDepth(f string) int {
	depth, deepest := 0, 0
	for i := range len(f) {
		switch f[i] {
		case '(':
			depth++
			deepest = max(deepest, depth)
		case ')':
			depth--
		}
	}
	return deepest
}

// typelessMatch is what secretFilterAttr names for an extensible match
// without an attribute type, such as (:octetStringMatch:=guess): the server
// applies its rule to every attribute it fits, secret ones included.
const typelessMatch = "an extensible match without an attribute type"

// secretFilterAttr is the first secret attribute that filter matches on by
// value (equality, substrings, ordering, approximate or extensible), or "".
// Presence, as in (userPassword=*), is allowed: the inspector shows how many
// values are masked anyway. An extensible match without a type is named
// typelessMatch.
func secretFilterAttr(filter string, s *schema.Schema) (string, error) {
	p, err := ldap.CompileFilter(filter)
	if err != nil {
		return "", err
	}
	return secretPacketAttr(p, s), nil
}

// secretPacketAttr is secretFilterAttr on a compiled filter.
func secretPacketAttr(p *ber.Packet, s *schema.Schema) string {
	switch p.Tag {
	case ldap.FilterAnd, ldap.FilterOr, ldap.FilterNot:
		for _, c := range p.Children {
			if a := secretPacketAttr(c, s); a != "" {
				return a
			}
		}
	case ldap.FilterEqualityMatch, ldap.FilterSubstrings, ldap.FilterGreaterOrEqual,
		ldap.FilterLessOrEqual, ldap.FilterApproxMatch:
		if len(p.Children) == 0 {
			return ""
		}
		if a := p.Children[0].Data.String(); IsSecret(a, s) {
			return a
		}
	case ldap.FilterExtensibleMatch:
		for _, c := range p.Children {
			if c.Tag == ldap.MatchingRuleAssertionType {
				if IsSecret(c.Data.String(), s) {
					return c.Data.String()
				}
				return ""
			}
		}
		// ponytail: refuses every typeless match, also one whose rule fits
		// no secret attribute; compare the rule with the secret types'
		// rules in the schema if someone needs those.
		return typelessMatch
	}
	return ""
}
