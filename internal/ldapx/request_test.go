// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"errors"
	"strings"
	"testing"

	"github.com/go-ldap/ldap/v3"

	"github.com/cicdteam/ldaplens/internal/schema"
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
	req, limit, err := buildRequest(SearchRequest{BaseDN: "dc=example,dc=org"}, true)
	if err != nil {
		t.Fatalf("buildRequest() error = %v", err)
	}
	if req.Scope != ldap.ScopeWholeSubtree || req.Filter != "(objectClass=*)" || req.DerefAliases != ldap.NeverDerefAliases {
		t.Errorf("buildRequest() = scope %d filter %q deref %d, want subtree, (objectClass=*), never", req.Scope, req.Filter, req.DerefAliases)
	}
	if got := pagingOf(t, req).PagingSize; got != 500 || limit != 500 || req.SizeLimit != 0 {
		t.Errorf("buildRequest() = paging size %d, limit %d, size limit %d; want 500, 500 and no server size limit", got, limit, req.SizeLimit)
	}
}

func TestBuildRequestPaging(t *testing.T) {
	tests := []struct {
		name      string
		r         SearchRequest
		wantPage  uint32
		wantLimit int
	}{
		{name: "page size above the limit", r: SearchRequest{PageSize: 100000}, wantPage: 500, wantLimit: 500},
		{name: "default page size", r: SearchRequest{SizeLimit: 1000}, wantPage: 500, wantLimit: 1000},
		{name: "page size hint", r: SearchRequest{PageSize: 1000, SizeLimit: 2000}, wantPage: 1000, wantLimit: 2000},
		{name: "limit over the ceiling", r: SearchRequest{PageSize: 100000, SizeLimit: 100000}, wantPage: 5000, wantLimit: 5000},
	}
	for _, tc := range tests {
		req, limit, err := buildRequest(tc.r, true)
		if err != nil {
			t.Errorf("%s: buildRequest() error = %v", tc.name, err)
			continue
		}
		ctl := pagingOf(t, req)
		if ctl.PagingSize != tc.wantPage || len(ctl.Cookie) != 0 || limit != tc.wantLimit {
			t.Errorf("%s: buildRequest() = paging size %d cookie %q, limit %d; want %d, no cookie, %d",
				tc.name, ctl.PagingSize, ctl.Cookie, limit, tc.wantPage, tc.wantLimit)
		}
	}
}

func TestBuildRequestWithoutPaging(t *testing.T) {
	tests := []struct {
		r    SearchRequest
		want int
	}{
		{r: SearchRequest{PageSize: 100}, want: 500},
		{r: SearchRequest{PageSize: 100, SizeLimit: 10}, want: 10},
		{r: SearchRequest{SizeLimit: 100000}, want: 5000},
	}
	for _, tc := range tests {
		req, limit, err := buildRequest(tc.r, false)
		if err != nil {
			t.Errorf("buildRequest(%+v, no paging) error = %v", tc.r, err)
			continue
		}
		if req.SizeLimit != tc.want || limit != tc.want || len(req.Controls) != 0 {
			t.Errorf("buildRequest(%+v, no paging) = size limit %d, limit %d, controls %v; want %d, %d, none",
				tc.r, req.SizeLimit, limit, req.Controls, tc.want, tc.want)
		}
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
		{name: "negative size limit", r: SearchRequest{SizeLimit: -1}, paging: true, wantInvalid: true},
		{name: "nested 64 deep", r: SearchRequest{Filter: nestedFilter(64)}, paging: true},
		{name: "nested 65 deep", r: SearchRequest{Filter: nestedFilter(65)}, paging: true, wantInvalid: true},
		{name: "filter of 16 KiB", r: SearchRequest{Filter: "(cn=" + strings.Repeat("x", 16<<10-5) + ")"}, paging: true},
		{name: "filter over 16 KiB", r: SearchRequest{Filter: "(cn=" + strings.Repeat("x", 16<<10-4) + ")"}, paging: true, wantInvalid: true},
	}
	for _, tc := range tests {
		_, _, err := buildRequest(tc.r, tc.paging)
		if got := errors.Is(err, ErrInvalidRequest); got != tc.wantInvalid {
			t.Errorf("%s: errors.Is(%v, ErrInvalidRequest) = %v, want %v", tc.name, err, got, tc.wantInvalid)
		}
		if got := ldap.IsErrorWithCode(err, ldap.ErrorFilterCompile); got != tc.wantFilterErr {
			t.Errorf("%s: filter compile error = %v (%v), want %v", tc.name, got, err, tc.wantFilterErr)
		}
	}
}

func TestSecretFilterAttr(t *testing.T) {
	tests := []struct {
		filter string
		want   string
	}{
		{filter: "(userPassword=x*)", want: "userPassword"},
		{filter: "(&(uid=a)(|(unicodePwd=x)))", want: "unicodePwd"},
		{filter: "(!(2.5.4.35>=a))", want: "2.5.4.35"},
		{filter: "(userPassword~=a)", want: "userPassword"},
		{filter: "(userPassword:caseExactMatch:=a)", want: "userPassword"},
		// Without a type the rule applies to every attribute it fits, so
		// (:octetStringMatch:=guess) tests userPassword on OpenLDAP.
		{filter: "(:octetStringMatch:=a)", want: typelessMatch},
		{filter: "(&(cn=a)(:dn:2.5.13.5:=a))", want: typelessMatch},
		// Presence is allowed: the inspector shows the masked value count.
		{filter: "(userPassword=*)", want: ""},
		{filter: "(cn=userPassword)", want: ""},
		{filter: "(cn:caseExactMatch:=a)", want: ""},
		{filter: "(uid=*)", want: ""},
	}
	s := schema.Parse(nil, nil, nil)
	for _, tc := range tests {
		got, err := secretFilterAttr(tc.filter, s)
		if err != nil || got != tc.want {
			t.Errorf("secretFilterAttr(%q) = %q, %v, want %q, nil", tc.filter, got, err, tc.want)
		}
	}
}
