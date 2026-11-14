// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"errors"
	"strings"
	"testing"

	"github.com/go-ldap/ldap/v3"
)

func pagingOf(t *testing.T, req *ldap.SearchRequest) *ldap.ControlPaging {
	t.Helper()
	ctl, ok := ldap.FindControl(req.Controls, ldap.ControlTypePaging).(*ldap.ControlPaging)
	if !ok {
		t.Fatalf("request has no paging control: %v", req.Controls)
	}
	return ctl
}

// nestedFilter returns a valid filter whose parentheses nest depth levels.
func nestedFilter(depth int) string {
	return strings.Repeat("(&", depth-1) + "(cn=x)" + strings.Repeat(")", depth-1)
}

func TestBuildRequestDefaults(t *testing.T) {
	req, err := buildRequest(SearchRequest{BaseDN: "dc=example,dc=org"}, true)
	if err != nil {
		t.Fatalf("buildRequest() error = %v", err)
	}
	if req.Scope != ldap.ScopeWholeSubtree || req.Filter != "(objectClass=*)" || req.DerefAliases != ldap.NeverDerefAliases {
		t.Errorf("buildRequest() = scope %d filter %q deref %d, want subtree, (objectClass=*), never", req.Scope, req.Filter, req.DerefAliases)
	}
	if got := pagingOf(t, req).PagingSize; got != defaultPageSize {
		t.Errorf("paging size = %d, want %d", got, defaultPageSize)
	}
}

func TestBuildRequestPaging(t *testing.T) {
	// The cursor is an ID that Conn.Search resolves to the cookie.
	req, err := buildRequest(SearchRequest{PageSize: 100000, Cursor: "SOMEID"}, true)
	if err != nil {
		t.Fatalf("buildRequest() error = %v", err)
	}
	ctl := pagingOf(t, req)
	if ctl.PagingSize != maxPageSize || len(ctl.Cookie) != 0 {
		t.Errorf("paging = size %d cookie %q, want %d and no cookie", ctl.PagingSize, ctl.Cookie, maxPageSize)
	}
}

func TestBuildRequestWithoutPaging(t *testing.T) {
	req, err := buildRequest(SearchRequest{PageSize: 100}, false)
	if err != nil {
		t.Fatalf("buildRequest() error = %v", err)
	}
	if req.SizeLimit != 100 || len(req.Controls) != 0 {
		t.Errorf("buildRequest(no paging) = size limit %d controls %v, want 100 and none", req.SizeLimit, req.Controls)
	}
	req, err = buildRequest(SearchRequest{PageSize: 100, SizeLimit: 10}, false)
	if err != nil || req.SizeLimit != 10 {
		t.Errorf("buildRequest(no paging, sizeLimit 10) = %v, %v, want size limit 10", req, err)
	}
}

func TestBuildRequest(t *testing.T) {
	tests := []struct {
		name          string
		r             SearchRequest
		paging        bool
		wantInvalid   bool
		wantFilterErr bool
	}{
		{name: "bad scope", r: SearchRequest{Scope: "children"}, paging: true, wantInvalid: true},
		{name: "unbalanced filter", r: SearchRequest{Filter: "(cn=x"}, paging: true, wantFilterErr: true},
		{name: "whitespace filter", r: SearchRequest{Filter: "   "}, paging: true, wantFilterErr: true},
		{name: "cursor without paging", r: SearchRequest{Cursor: "YWJj"}, paging: false, wantInvalid: true},
		{name: "negative size limit", r: SearchRequest{SizeLimit: -1}, paging: true, wantInvalid: true},
		{name: "nested 64 deep", r: SearchRequest{Filter: nestedFilter(64)}, paging: true},
		{name: "nested 65 deep", r: SearchRequest{Filter: nestedFilter(65)}, paging: true, wantInvalid: true},
		{name: "filter of 16 KiB", r: SearchRequest{Filter: "(cn=" + strings.Repeat("x", 16<<10-5) + ")"}, paging: true},
		{name: "filter over 16 KiB", r: SearchRequest{Filter: "(cn=" + strings.Repeat("x", 16<<10-4) + ")"}, paging: true, wantInvalid: true},
	}
	for _, tc := range tests {
		_, err := buildRequest(tc.r, tc.paging)
		if got := errors.Is(err, ErrInvalidRequest); got != tc.wantInvalid {
			t.Errorf("%s: errors.Is(%v, ErrInvalidRequest) = %v, want %v", tc.name, err, got, tc.wantInvalid)
		}
		if got := ldap.IsErrorWithCode(err, ldap.ErrorFilterCompile); got != tc.wantFilterErr {
			t.Errorf("%s: filter compile error = %v (%v), want %v", tc.name, got, err, tc.wantFilterErr)
		}
	}
}
