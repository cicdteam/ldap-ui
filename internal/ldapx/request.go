// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"errors"
	"fmt"

	"github.com/go-ldap/ldap/v3"
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
	// time limit; Entries holds what arrived before that.
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
