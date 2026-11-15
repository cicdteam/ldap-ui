// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"
	"github.com/google/go-cmp/cmp"

	"github.com/cicdteam/ldap-ui/internal/ldapx"
)

const twoEntries = `{"entries":[
 {"dn":"uid=a,dc=example,dc=org","changes":[{"op":"delete","attr":"mail","values":["old-secret-value"]},{"op":"add","attr":"mail","values":["new-secret-value"]}]},
 {"dn":"uid=b,dc=example,dc=org","changes":[{"op":"add","attr":"description","values":["x"]}]}]}`

func connectTo(t *testing.T, env *testEnv, body string) {
	t.Helper()
	if rec := env.do(t, http.MethodPost, "/api/connect", body); rec.Code != http.StatusOK {
		t.Fatalf("connect %s = %d %s", body, rec.Code, rec.Body)
	}
}

func applyResultOf(t *testing.T, body []byte) applyResult {
	t.Helper()
	var r applyResult
	if err := json.Unmarshal(body, &r); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return r
}

func TestApplyAll(t *testing.T) {
	var logs bytes.Buffer
	env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	connectTo(t, env, `{"profile":"dev"}`)
	rec := env.do(t, http.MethodPost, "/api/c/dev/changes/apply", twoEntries)
	if rec.Code != http.StatusOK {
		t.Fatalf("apply = %d %s, want 200", rec.Code, rec.Body)
	}
	got := applyResultOf(t, rec.Body.Bytes())
	want := applyResult{Applied: []string{"uid=a,dc=example,dc=org", "uid=b,dc=example,dc=org"}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("apply result (-want +got):\n%s", diff)
	}
	if n := len(env.dir.changes["uid=a,dc=example,dc=org"]); n != 2 {
		t.Errorf("changes sent for uid=a = %d, want 2", n)
	}
	if strings.Contains(logs.String(), "secret-value") {
		t.Errorf("log contains attribute values:\n%s", logs.String())
	}
}

func TestApplyStopsAtFirstFailure(t *testing.T) {
	env := connected(t)
	env.dir.modifyErr = map[string]error{
		"uid=a,dc=example,dc=org": ldap.NewError(ldap.LDAPResultNoSuchAttribute, errors.New("modify/delete: mail: no such value")),
	}
	rec := env.do(t, http.MethodPost, "/api/c/dev/changes/apply", twoEntries)
	if rec.Code != http.StatusOK {
		t.Fatalf("apply = %d %s, want 200", rec.Code, rec.Body)
	}
	got := applyResultOf(t, rec.Body.Bytes())
	if len(got.Applied) != 0 || got.Failed == nil || got.Failed.DN != "uid=a,dc=example,dc=org" ||
		got.Failed.Error.Code != "conflict" || got.Failed.Error.Attribute != "mail" {
		t.Errorf("apply result = %+v, want nothing applied, uid=a failed with conflict on mail", got)
	}
	if len(env.dir.modified) != 0 {
		t.Errorf("modified = %v, want none after the first failure", env.dir.modified)
	}
}

func TestApplyNetworkErrorNamesNoAttribute(t *testing.T) {
	env := connected(t)
	env.dir.modifyErr = map[string]error{
		"uid=a,dc=example,dc=org": ldap.NewError(ldap.ErrorNetwork, errors.New("connection reset")),
	}
	got := applyResultOf(t, env.do(t, http.MethodPost, "/api/c/dev/changes/apply", twoEntries).Body.Bytes())
	if got.Failed == nil || got.Failed.Error.Code != "network" || got.Failed.Error.Attribute != "" {
		t.Errorf("apply result = %+v, want uid=a failed with network and no attribute", got)
	}
}

func TestApplyPartial(t *testing.T) {
	env := connected(t)
	env.dir.modifyErr = map[string]error{
		"uid=b,dc=example,dc=org": ldap.NewError(ldap.LDAPResultInsufficientAccessRights, errors.New("no write access")),
	}
	got := applyResultOf(t, env.do(t, http.MethodPost, "/api/c/dev/changes/apply", twoEntries).Body.Bytes())
	if diff := cmp.Diff([]string{"uid=a,dc=example,dc=org"}, got.Applied); diff != "" || got.Failed == nil || got.Failed.Error.Code != "insufficient_access" {
		t.Errorf("apply result = %+v, want uid=a applied and uid=b insufficient_access", got)
	}
}

func TestApplyStopsWhenContextEnds(t *testing.T) {
	const (
		a = "uid=a,dc=example,dc=org"
		b = "uid=b,dc=example,dc=org"
		c = "uid=c,dc=example,dc=org"
	)
	body := `{"entries":[
 {"dn":"` + a + `","changes":[{"op":"add","attr":"description","values":["x"]}]},
 {"dn":"` + b + `","changes":[{"op":"add","attr":"description","values":["x"]}]},
 {"dn":"` + c + `","changes":[{"op":"add","attr":"description","values":["x"]}]}]}`
	tests := []struct {
		name    string
		timeout time.Duration
		// cancel ends the request during the 2nd modify; otherwise its
		// deadline does.
		cancel bool
		want   error
	}{
		{name: "client gone", timeout: time.Minute, cancel: true, want: context.Canceled},
		{name: "deadline", timeout: 250 * time.Millisecond, want: context.DeadlineExceeded},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := connected(t)
			ctx, cancel := context.WithTimeout(context.Background(), tc.timeout)
			defer cancel()
			env.dir.onModify = func(ctx context.Context, dn string) {
				if dn != b {
					return
				}
				if tc.cancel {
					cancel()
				}
				// The modify was sent, so it finishes after the request ended.
				<-ctx.Done()
			}
			rec := env.doContext(ctx, t, http.MethodPost, "/api/c/dev/changes/apply", body)
			if rec.Code != http.StatusOK {
				t.Fatalf("apply = %d %s, want 200", rec.Code, rec.Body)
			}
			_, wantErr := errorResponse(tc.want)
			want := applyResult{Applied: []string{a, b}, Failed: &applyFailure{DN: c, Error: wantErr}}
			if diff := cmp.Diff(want, applyResultOf(t, rec.Body.Bytes())); diff != "" {
				t.Errorf("apply result (-want +got):\n%s", diff)
			}
			if diff := cmp.Diff([]string{a, b}, env.dir.modified); diff != "" {
				t.Errorf("modified (-want +got):\n%s", diff)
			}
		})
	}
}

func TestApplyRefusals(t *testing.T) {
	// The largest value a write takes is 1 MiB once decoded; one byte more is refused.
	big := base64.StdEncoding.EncodeToString(make([]byte, ldapx.MaxValue+1))
	long := strings.Repeat("x", ldapx.MaxValue+1)
	tests := []struct {
		name       string
		connect    string
		conn       string
		body       string
		wantStatus int
		wantCode   string
		wantAttr   string
		wantMsg    string
	}{
		{name: "read-only profile", connect: `{"profile":"manual","password":"x"}`, conn: "manual", body: twoEntries, wantStatus: http.StatusForbidden, wantCode: "read_only"},
		{name: "prod without confirm", connect: `{"profile":"prodrw"}`, conn: "prodrw", body: twoEntries, wantStatus: http.StatusConflict, wantCode: "confirmation_required"},
		{name: "prod wrong confirm", connect: `{"profile":"prodrw"}`, conn: "prodrw", body: strings.Replace(twoEntries, `{"entries"`, `{"confirm":"dev","entries"`, 1), wantStatus: http.StatusConflict, wantCode: "confirmation_required"},
		{name: "no entries", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request"},
		{name: "empty dn", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":" ","changes":[{"op":"add","attr":"cn","values":["x"]}]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request"},
		{name: "no changes", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":"uid=a","changes":[]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request"},
		{name: "unknown op", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":"uid=a","changes":[{"op":"replace","attr":"cn","values":["x"]}]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request", wantAttr: "cn"},
		{name: "secret by name", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":"uid=a","changes":[{"op":"add","attr":"userPassword","values":["x"]}]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request", wantAttr: "userPassword"},
		{name: "secret by OID", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":"uid=a","changes":[{"op":"add","attr":"2.5.4.35","values":["x"]}]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request", wantAttr: "2.5.4.35"},
		{name: "empty values", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":"uid=a","changes":[{"op":"add","attr":"cn","values":[]}]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request", wantAttr: "cn"},
		{name: "empty value", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":"uid=a","changes":[{"op":"add","attr":"cn","values":[""]}]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request", wantAttr: "cn"},
		{name: "not base64", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":"uid=a","changes":[{"op":"add","attr":"jpegPhoto","base64":true,"values":["not base64!"]}]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request", wantAttr: "jpegPhoto", wantMsg: "jpegPhoto: value is not base64"},
		{name: "binary value over 1 MiB", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":"uid=a","changes":[{"op":"add","attr":"jpegPhoto","base64":true,"values":["` + big + `"]}]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request", wantAttr: "jpegPhoto", wantMsg: "jpegPhoto: value is larger than 1 MiB"},
		{name: "text value over 1 MiB", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[{"dn":"uid=a","changes":[{"op":"add","attr":"description","values":["` + long + `"]}]}]}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request", wantAttr: "description", wantMsg: "description: value is larger than 1 MiB"},
		{name: "unknown field", connect: `{"profile":"dev"}`, conn: "dev", body: `{"entries":[],"x":1}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			connectTo(t, env, tc.connect)
			rec := env.do(t, http.MethodPost, "/api/c/"+tc.conn+"/changes/apply", tc.body)
			var e apiError
			_ = json.Unmarshal(rec.Body.Bytes(), &e)
			if rec.Code != tc.wantStatus || e.Code != tc.wantCode || e.Attribute != tc.wantAttr || (tc.wantMsg != "" && e.Message != tc.wantMsg) {
				t.Errorf("apply = %d %+v, want %d %s attribute %q message %q", rec.Code, e, tc.wantStatus, tc.wantCode, tc.wantAttr, tc.wantMsg)
			}
			if len(env.dir.modified) != 0 {
				t.Errorf("modified = %v, want none", env.dir.modified)
			}
		})
	}
}

func TestApplyProdWithConfirm(t *testing.T) {
	env := newTestEnv(t)
	connectTo(t, env, `{"profile":"prodrw"}`)
	body := strings.Replace(twoEntries, `{"entries"`, `{"confirm":"prodrw","entries"`, 1)
	if rec := env.do(t, http.MethodPost, "/api/c/prodrw/changes/apply", body); rec.Code != http.StatusOK {
		t.Errorf("apply with confirm = %d %s, want 200", rec.Code, rec.Body)
	}
}

func TestBlame(t *testing.T) {
	tests := []struct {
		name       string
		attrs      []string
		diagnostic string
		want       string
	}{
		{name: "single attribute", attrs: []string{"mail"}, diagnostic: "", want: "mail"},
		{name: "one attribute twice", attrs: []string{"mail", "MAIL"}, diagnostic: "", want: "mail"},
		{name: "named in diagnostic", attrs: []string{"mail", "description"}, diagnostic: "modify/add: description: value #0 already exists", want: "description"},
		{name: "case-insensitive", attrs: []string{"displayName", "mail"}, diagnostic: "attribute 'displayname' cannot have multiple values", want: "displayName"},
		{name: "unknown", attrs: []string{"mail", "description"}, diagnostic: "something else", want: ""},
		{name: "word boundary", attrs: []string{"cn", "mail"}, diagnostic: "mail: no such value", want: "mail"},
		{name: "inside a longer name", attrs: []string{"cn", "description"}, diagnostic: "cnAlias: bad value", want: ""},
		{name: "options are part of the name", attrs: []string{"cn", "cn;lang-de"}, diagnostic: "modify/add: cn;lang-de: value #0 already exists", want: "cn;lang-de"},
		{name: "the name without options", attrs: []string{"cn", "cn;lang-de"}, diagnostic: "modify/add: cn: value #0 already exists", want: "cn"},
		{name: "a server that names the type only", attrs: []string{"cn;lang-de", "mail"}, diagnostic: "problem 1006 (ATT_OR_VALUE_EXISTS), data 0, Att 3 (cn)", want: "cn;lang-de"},
	}
	for _, tc := range tests {
		if got := blame(tc.attrs, tc.diagnostic); got != tc.want {
			t.Errorf("%s: blame(%v, %q) = %q, want %q", tc.name, tc.attrs, tc.diagnostic, got, tc.want)
		}
	}
}

// photoB64 stands for a binary value; no log may show it.
var photoB64 = base64.StdEncoding.EncodeToString([]byte("\xff\xd8\xff photo bytes"))

func TestBinaryValuesReachTheDirectory(t *testing.T) {
	var logs bytes.Buffer
	env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	connectTo(t, env, `{"profile":"dev"}`)
	apply := `{"entries":[{"dn":"uid=a,dc=example,dc=org","changes":[{"op":"add","attr":"jpegPhoto","base64":true,"values":["` + photoB64 + `"]}]}]}`
	if rec := env.do(t, http.MethodPost, "/api/c/dev/changes/apply", apply); rec.Code != http.StatusOK {
		t.Fatalf("apply = %d %s, want 200", rec.Code, rec.Body)
	}
	wantChanges := []ldapx.Change{{Op: "add", Attr: "jpegPhoto", Values: []string{photoB64}, Base64: true}}
	if diff := cmp.Diff(wantChanges, env.dir.changes["uid=a,dc=example,dc=org"]); diff != "" {
		t.Errorf("changes sent (-want +got):\n%s", diff)
	}
	add := `{"dn":"uid=n,dc=example,dc=org","attributes":[{"name":"objectClass","values":["inetOrgPerson"]},{"name":"jpegPhoto","base64":true,"values":["` + photoB64 + `"]}]}`
	if rec := env.do(t, http.MethodPost, "/api/c/dev/entries/add", add); rec.Code != http.StatusOK {
		t.Fatalf("add = %d %s, want 200", rec.Code, rec.Body)
	}
	wantAttrs := []ldapx.TextAttribute{
		{Name: "objectClass", Values: []string{"inetOrgPerson"}},
		{Name: "jpegPhoto", Values: []string{photoB64}, Base64: true},
	}
	if diff := cmp.Diff(wantAttrs, env.dir.added); diff != "" {
		t.Errorf("attributes sent (-want +got):\n%s", diff)
	}
	if strings.Contains(logs.String(), photoB64) {
		t.Errorf("log contains a base64 value:\n%s", logs.String())
	}
}

func TestWriteBodyLimits(t *testing.T) {
	// base64 of 1 MiB, the largest value a write takes.
	mib := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xff}, ldapx.MaxValue))
	values := func(n int) string { return strings.TrimSuffix(strings.Repeat(`"`+mib+`",`, n), ",") }
	apply := func(n int) string {
		return `{"entries":[{"dn":"uid=a,dc=example,dc=org","changes":[{"op":"add","attr":"jpegPhoto","base64":true,"values":[` + values(n) + `]}]}]}`
	}
	add := func(n int) string {
		return `{"dn":"uid=n,dc=example,dc=org","attributes":[{"name":"objectClass","values":["inetOrgPerson"]},{"name":"jpegPhoto","base64":true,"values":[` + values(n) + `]}]}`
	}
	// Five such values make about 7 MB of JSON, seven about 9.8 MB: under and over 8 MiB.
	tests := []struct {
		name       string
		path       string
		body       string
		wantStatus int
	}{
		{name: "apply under 8 MiB", path: "changes/apply", body: apply(5), wantStatus: http.StatusOK},
		{name: "apply over 8 MiB", path: "changes/apply", body: apply(7), wantStatus: http.StatusBadRequest},
		{name: "add under 8 MiB", path: "entries/add", body: add(5), wantStatus: http.StatusOK},
		{name: "add over 8 MiB", path: "entries/add", body: add(7), wantStatus: http.StatusBadRequest},
		// The other writes keep the 1 MiB limit: this rename would pass under 8 MiB.
		{name: "rename over 1 MiB", path: "entries/rename", body: `{"dn":"uid=n,dc=x","newRDN":"uid=` + strings.Repeat("m", 1<<20) + `"}`, wantStatus: http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := connected(t)
			rec := env.do(t, http.MethodPost, "/api/c/dev/"+tc.path, tc.body)
			if rec.Code != tc.wantStatus {
				t.Fatalf("%s = %d %.200s, want %d", tc.path, rec.Code, rec.Body, tc.wantStatus)
			}
			if tc.wantStatus == http.StatusBadRequest && !strings.Contains(rec.Body.String(), "request body too large") {
				t.Errorf("%s body = %.200s, want a too-large refusal", tc.path, rec.Body)
			}
		})
	}
}

// TestBlameManyNames bounds blame on 50 000 names that its diagnostic does
// not name: a scan per name made it quadratic.
func TestBlameManyNames(t *testing.T) {
	names := make([]string, 50000)
	for i := range names {
		names[i] = "a" + strconv.Itoa(i)
	}
	const diagnostic = "modify/add: description: value #0 already exists"
	start := time.Now()
	got := blame(names, diagnostic)
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("blame(50000 names, %q) took %v, want at most 5s", diagnostic, elapsed)
	}
	if got != "" {
		t.Errorf("blame(50000 names, %q) = %q, want \"\"", diagnostic, got)
	}
}

// TestFoldKey checks that foldKey keys exactly what strings.EqualFold
// matches, also where strings.ToLower disagrees with EqualFold: long s,
// dotted capital I and final sigma.
func TestFoldKey(t *testing.T) {
	pairs := [][2]string{
		{"cn", "CN"},
		{"cn", "cn;x"},
		{"objectClass", "OBJECTCLASS"},
		{"a", ""},
		{"sn", "\u017fn"},
		{"i", "\u0130"},
		{"k", "\u212a"},
		{"\u03a3", "\u03c2"},
		{"\xff", "\ufffd"},
	}
	for _, p := range pairs {
		if got, want := foldKey(p[0]) == foldKey(p[1]), strings.EqualFold(p[0], p[1]); got != want {
			t.Errorf("foldKey(%q) == foldKey(%q) is %v, want %v as strings.EqualFold", p[0], p[1], got, want)
		}
	}
}
