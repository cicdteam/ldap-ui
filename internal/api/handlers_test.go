// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"
	"github.com/google/go-cmp/cmp"

	"github.com/cicdteam/ldap-ui/internal/ldapx"
	"github.com/cicdteam/ldap-ui/internal/profile"
	"github.com/cicdteam/ldap-ui/internal/schema"
	"github.com/cicdteam/ldap-ui/internal/session"
)

// The real connection must keep satisfying Directory.
var _ Directory = (*ldapx.Conn)(nil)

type directoryFake struct {
	info       ldapx.Info
	entry      ldapx.Entry
	err        error
	lastSearch ldapx.SearchRequest
	lastDN     string
	lastNested bool
	closed     bool
	modified   []string
	changes    map[string][]ldapx.Change
	modifyErr  map[string]error
	// writes records Add, Delete, Rename and SetPassword calls, one line each.
	writes   []string
	writeErr error
	// added is the attributes of the last Add.
	added []ldapx.TextAttribute
	// password is the last password SetPassword got; writes never holds it.
	password string
}

func (d *directoryFake) Close() error     { d.closed = true; return nil }
func (d *directoryFake) Info() ldapx.Info { return d.info }
func (d *directoryFake) Schema(context.Context) (*schema.Schema, error) {
	return schema.Parse(nil, nil, nil), d.err
}

func (d *directoryFake) ReloadSchema(context.Context) (*schema.Schema, error) {
	return schema.Parse(nil, nil, nil), d.err
}

func (d *directoryFake) Search(_ context.Context, r ldapx.SearchRequest) (ldapx.Page, error) {
	d.lastSearch = r
	return ldapx.Page{}, d.err
}

func (d *directoryFake) Entry(_ context.Context, dn string) (ldapx.Entry, error) {
	d.lastDN = dn
	return d.entry, d.err
}

func (d *directoryFake) MemberOf(_ context.Context, dn string, nested bool) (ldapx.Membership, error) {
	d.lastDN, d.lastNested = dn, nested
	return ldapx.Membership{Refs: []ldapx.Ref{{DN: "cn=g"}}}, d.err
}

// Members reports a truncated empty result, as ldapx does when a server
// limit cut the group index short.
func (d *directoryFake) Members(_ context.Context, dn string, nested bool) (ldapx.Membership, error) {
	d.lastDN, d.lastNested = dn, nested
	return ldapx.Membership{Refs: []ldapx.Ref{}, Truncated: true}, d.err
}

func (d *directoryFake) Modify(_ context.Context, dn string, changes []ldapx.Change) error {
	if err := d.modifyErr[dn]; err != nil {
		return err
	}
	d.modified = append(d.modified, dn)
	if d.changes == nil {
		d.changes = map[string][]ldapx.Change{}
	}
	d.changes[dn] = changes
	return nil
}

func (d *directoryFake) Add(_ context.Context, dn string, attrs []ldapx.TextAttribute) error {
	d.added = attrs
	names := make([]string, len(attrs))
	for i, a := range attrs {
		names[i] = a.Name
	}
	d.writes = append(d.writes, fmt.Sprintf("add %s %v", dn, names))
	return d.writeErr
}

func (d *directoryFake) Delete(_ context.Context, dn string) error {
	d.writes = append(d.writes, "delete "+dn)
	return d.writeErr
}

func (d *directoryFake) Rename(_ context.Context, dn, newRDN, newParent string, deleteOld bool) error {
	d.writes = append(d.writes, fmt.Sprintf("rename %s %s %s deleteOld=%v", dn, newRDN, newParent, deleteOld))
	return d.writeErr
}

func (d *directoryFake) SetPassword(_ context.Context, dn, password, method string) error {
	d.password = password
	d.writes = append(d.writes, fmt.Sprintf("password %s %s", dn, method))
	return d.writeErr
}

type testEnv struct {
	h        http.Handler
	dir      *directoryFake
	dialErr  error
	password string // password of the last dial
	cookies  []*http.Cookie
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	return newTestEnvWith(t, Options{})
}

// newTestEnvWith is newTestEnv with extra options. It always sets Catalog,
// Sessions and Dial.
func newTestEnvWith(t *testing.T, opts Options) *testEnv {
	t.Helper()
	t.Setenv("LDAPUI_TEST_PW", "from-env")
	no := false
	cat, err := profile.NewCatalog([]profile.Profile{
		{Name: "dev", URL: "ldap://dev:389", BindDN: "cn=admin,dc=example,dc=org", PasswordEnv: "LDAPUI_TEST_PW"}, //nolint:gosec // env var name, not a credential
		{Name: "manual", URL: "ldap://manual:389", BindDN: "cn=admin,dc=example,dc=org", Environment: profile.Prod, InsecureSkipVerify: true, Color: "red"},
		{Name: "anon", URL: "ldap://anon:389"},
		{Name: "prodrw", URL: "ldap://prodrw:389", Environment: profile.Prod, ReadOnly: &no},
	}, t.TempDir())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	env := &testEnv{dir: &directoryFake{info: ldapx.Info{BaseDN: "dc=example,dc=org"}}}
	opts.Catalog = cat
	opts.Sessions = session.New[Directory](time.Hour)
	opts.Dial = func(_ context.Context, _ profile.Profile, password string) (Directory, error) {
		env.password = password
		if env.dialErr != nil {
			return nil, env.dialErr
		}
		return env.dir, nil
	}
	env.h = New(opts)
	return env
}

// do sends a same-origin request to localhost, replaying cookies set by
// earlier responses.
func (e *testEnv) do(t *testing.T, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, r)
	req.Host = "localhost:8080"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, c := range e.cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	e.cookies = append(e.cookies, (&http.Response{Header: rec.Header()}).Cookies()...)
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var e apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	return e.Code
}

func TestConnectUsesConfiguredPassword(t *testing.T) {
	env := newTestEnv(t)
	rec := env.do(t, http.MethodPost, "/api/connect", `{"profile":"dev"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("connect = %d %s, want 200", rec.Code, rec.Body)
	}
	if env.password != "from-env" {
		t.Errorf("dial password = %q, want the configured one", env.password)
	}
	if rec := env.do(t, http.MethodGet, "/api/c/dev/info", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"baseDN":"dc=example,dc=org"`) {
		t.Errorf("info after connect = %d %s, want 200 with baseDN", rec.Code, rec.Body)
	}
}

func TestConnectErrors(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		dialErr    error
		wantStatus int
		wantCode   string
	}{
		{name: "password required", body: `{"profile":"manual"}`, wantStatus: http.StatusBadRequest, wantCode: "password_required"},
		{name: "unknown profile", body: `{"profile":"nope"}`, wantStatus: http.StatusNotFound, wantCode: "profile_not_found"},
		{
			name: "bad credentials", body: `{"profile":"manual","password":"x"}`,
			dialErr: ldap.NewError(ldap.LDAPResultInvalidCredentials, errors.New("data 775")), wantStatus: http.StatusUnauthorized, wantCode: "invalid_credentials",
		},
		{
			name: "untrusted cert", body: `{"profile":"anon"}`,
			dialErr: &ldapx.UntrustedCertError{Err: x509.UnknownAuthorityError{}}, wantStatus: http.StatusBadGateway, wantCode: "tls_untrusted",
		},
		{name: "unknown field", body: `{"profile":"dev","extra":1}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request"},
	}
	for _, tc := range tests {
		env := newTestEnv(t)
		env.dialErr = tc.dialErr
		rec := env.do(t, http.MethodPost, "/api/connect", tc.body)
		if rec.Code != tc.wantStatus || errorCode(t, rec) != tc.wantCode {
			t.Errorf("%s: connect = %d %s, want %d %s", tc.name, rec.Code, rec.Body, tc.wantStatus, tc.wantCode)
		}
	}
}

// TestConnectHidesPasswordSource checks that a missing configured password
// is logged with its source but the client never sees the env var name.
func TestConnectHidesPasswordSource(t *testing.T) {
	var logs bytes.Buffer
	env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	if err := os.Unsetenv("LDAPUI_TEST_PW"); err != nil { // t.Setenv restores it
		t.Fatal(err)
	}
	rec := env.do(t, http.MethodPost, "/api/connect", `{"profile":"dev"}`)
	if rec.Code != http.StatusInternalServerError || errorCode(t, rec) != "password_unavailable" || strings.Contains(rec.Body.String(), "LDAPUI_TEST_PW") {
		t.Errorf("connect without env password = %d %s, want 500 password_unavailable without the env var name", rec.Code, rec.Body)
	}
	if !strings.Contains(logs.String(), "LDAPUI_TEST_PW") {
		t.Errorf("server log = %q, want the env var name", logs.String())
	}
}

// TestInternalErrorHidesDetails checks that an unexpected dial error, here
// a missing CA file, is logged but its path never reaches the client.
func TestInternalErrorHidesDetails(t *testing.T) {
	var logs bytes.Buffer
	env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	caFile := filepath.Join(t.TempDir(), "missing-ca.pem")
	if _, env.dialErr = (profile.Profile{Name: "dev", URL: "ldaps://dev:636", CAFile: caFile}).TLSConfig(); env.dialErr == nil {
		t.Fatal("TLSConfig() with a missing CA file succeeded")
	}
	rec := env.do(t, http.MethodPost, "/api/connect", `{"profile":"dev"}`)
	if rec.Code != http.StatusInternalServerError || errorCode(t, rec) != "internal" || strings.Contains(rec.Body.String(), caFile) {
		t.Errorf("connect with missing CA file = %d %s, want 500 internal without the path", rec.Code, rec.Body)
	}
	if !strings.Contains(logs.String(), caFile) {
		t.Errorf("server log = %q, want the CA file path", logs.String())
	}
}

// TestInfoCarriesProfileFlags checks that connect and info both return the
// profile settings the workspace shows as badges.
func TestInfoCarriesProfileFlags(t *testing.T) {
	type flags struct {
		BaseDN             string `json:"baseDN"`
		Environment        string `json:"environment"`
		ReadOnly           bool   `json:"readOnly"`
		InsecureSkipVerify bool   `json:"insecureSkipVerify"`
		Color              string `json:"color"`
	}
	want := flags{BaseDN: "dc=example,dc=org", Environment: "prod", ReadOnly: true, InsecureSkipVerify: true, Color: "red"}
	check := func(name string, rec *httptest.ResponseRecorder) {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("%s = %d %s, want 200", name, rec.Code, rec.Body)
		}
		var got flags
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: decode %q: %v", name, rec.Body, err)
		}
		if diff := cmp.Diff(want, got); diff != "" {
			t.Errorf("%s response mismatch (-want +got):\n%s", name, diff)
		}
	}
	env := newTestEnv(t)
	check("connect", env.do(t, http.MethodPost, "/api/connect", `{"profile":"manual","password":"pw"}`))
	check("info", env.do(t, http.MethodGet, "/api/c/manual/info", ""))
}

func TestNotConnected(t *testing.T) {
	env := newTestEnv(t)
	rec := env.do(t, http.MethodGet, "/api/c/dev/info", "")
	if rec.Code != http.StatusUnauthorized || errorCode(t, rec) != "not_connected" {
		t.Errorf("info without connect = %d %s, want 401 not_connected", rec.Code, rec.Body)
	}
}

func connected(t *testing.T) *testEnv {
	t.Helper()
	env := newTestEnv(t)
	if rec := env.do(t, http.MethodPost, "/api/connect", `{"profile":"dev"}`); rec.Code != http.StatusOK {
		t.Fatalf("connect = %d %s", rec.Code, rec.Body)
	}
	return env
}

func TestEntryPassesDNVerbatim(t *testing.T) {
	env := connected(t)
	dn := `cn=Smith\, John/Jr Ünal,ou=people,dc=example,dc=org`
	rec := env.do(t, http.MethodGet, "/api/c/dev/entry?dn="+url.QueryEscape(dn), "")
	if rec.Code != http.StatusOK || env.dir.lastDN != dn {
		t.Errorf("entry = %d, dn %q, want 200 and %q", rec.Code, env.dir.lastDN, dn)
	}
	if rec := env.do(t, http.MethodGet, "/api/c/dev/entry", ""); rec.Code != http.StatusBadRequest {
		t.Errorf("entry without dn = %d, want 400", rec.Code)
	}
}

func TestEntryLDAPError(t *testing.T) {
	env := connected(t)
	env.dir.err = ldap.NewError(ldap.LDAPResultNoSuchObject, errors.New(""))
	rec := env.do(t, http.MethodGet, "/api/c/dev/entry?dn=cn%3Dx", "")
	if rec.Code != http.StatusNotFound || errorCode(t, rec) != "no_such_object" {
		t.Errorf("entry missing = %d %s, want 404 no_such_object", rec.Code, rec.Body)
	}
}

func TestSearchDefaultsBase(t *testing.T) {
	env := connected(t)
	if rec := env.do(t, http.MethodPost, "/api/c/dev/search", `{"filter":"(cn=x)"}`); rec.Code != http.StatusOK {
		t.Fatalf("search = %d %s", rec.Code, rec.Body)
	}
	if env.dir.lastSearch.BaseDN != "dc=example,dc=org" || env.dir.lastSearch.Filter != "(cn=x)" {
		t.Errorf("search request = %+v, want base from Info and the given filter", env.dir.lastSearch)
	}
}

func TestSearchBadFilterIs400(t *testing.T) {
	env := connected(t)
	env.dir.err = ldap.NewError(ldap.ErrorFilterCompile, errors.New("unexpected end of filter"))
	rec := env.do(t, http.MethodPost, "/api/c/dev/search", `{"filter":"(cn=x"}`)
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "bad_filter" {
		t.Errorf("search bad filter = %d %s, want 400 bad_filter", rec.Code, rec.Body)
	}
}

func TestMembership(t *testing.T) {
	env := connected(t)
	rec := env.do(t, http.MethodGet, "/api/c/dev/memberof?dn=uid%3Da&nested=true", "")
	want := `{"refs":[{"dn":"cn=g"}]}`
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != want || env.dir.lastDN != "uid=a" || !env.dir.lastNested {
		t.Errorf("memberof = %d %s dn %q nested %v, want 200 %s uid=a true", rec.Code, rec.Body, env.dir.lastDN, env.dir.lastNested, want)
	}
	rec = env.do(t, http.MethodGet, "/api/c/dev/members?dn=cn%3Dg", "")
	want = `{"refs":[],"truncated":true}`
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != want || env.dir.lastNested {
		t.Errorf("members = %d %s nested %v, want 200 %s false", rec.Code, rec.Body, env.dir.lastNested, want)
	}
}

func TestDisconnectClosesConnection(t *testing.T) {
	env := connected(t)
	if rec := env.do(t, http.MethodPost, "/api/disconnect", `{"profile":"dev"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("disconnect = %d", rec.Code)
	}
	if !env.dir.closed {
		t.Error("disconnect did not close the directory")
	}
	if rec := env.do(t, http.MethodGet, "/api/c/dev/info", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("info after disconnect = %d, want 401", rec.Code)
	}
}

func TestProfilesNeverExposeSecrets(t *testing.T) {
	env := connected(t)
	rec := env.do(t, http.MethodGet, "/api/profiles", "")
	body := rec.Body.String()
	if rec.Code != http.StatusOK || strings.Contains(body, "from-env") || strings.Contains(body, "LDAPUI_TEST_PW") {
		t.Fatalf("profiles = %d %s, want 200 without password or env name", rec.Code, body)
	}
	var views []struct {
		Name        string `json:"name"`
		ReadOnly    bool   `json:"readOnly"`
		Editable    bool   `json:"editable"`
		HasPassword bool   `json:"hasPassword"`
		Connected   bool   `json:"connected"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &views); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, v := range views {
		got[v.Name] = strings.Join([]string{boolStr(v.ReadOnly), boolStr(v.Editable), boolStr(v.HasPassword), boolStr(v.Connected)}, ",")
	}
	want := map[string]string{"dev": "f,f,t,t", "manual": "t,f,f,f", "anon": "f,f,f,f"}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("profile %s readOnly,editable,hasPassword,connected = %s, want %s", name, got[name], w)
		}
	}
}

func boolStr(b bool) string {
	if b {
		return "t"
	}
	return "f"
}

func TestSaveProfile(t *testing.T) {
	env := newTestEnv(t)
	rec := env.do(t, http.MethodPost, "/api/profiles", `{"name":"lab","url":"ldap://lab:389","environment":"stage"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"editable":true`) {
		t.Errorf("save = %d %s, want 200 editable", rec.Code, rec.Body)
	}
	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "file reference", body: `{"name":"x","url":"ldap://h","passwordFile":"/etc/passwd"}`, wantStatus: http.StatusBadRequest, wantCode: "bad_request"},
		{name: "fixed name", body: `{"name":"dev","url":"ldap://h"}`, wantStatus: http.StatusConflict, wantCode: "profile_fixed"},
		{name: "invalid", body: `{"name":"x","url":"http://h"}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_profile"},
	}
	for _, tc := range tests {
		rec := env.do(t, http.MethodPost, "/api/profiles", tc.body)
		if rec.Code != tc.wantStatus || errorCode(t, rec) != tc.wantCode {
			t.Errorf("%s: save = %d %s, want %d %s", tc.name, rec.Code, rec.Body, tc.wantStatus, tc.wantCode)
		}
	}
}

// TestCookieScope checks that the token and session cookies share the
// base path and the SecureCookies setting.
func TestCookieScope(t *testing.T) {
	tests := []struct {
		name       string
		opts       Options
		wantPath   string
		wantSecure bool
	}{
		{name: "default", wantPath: "/"},
		{name: "base path", opts: Options{BasePath: "/ldap"}, wantPath: "/ldap/"},
		{name: "secure cookies", opts: Options{SecureCookies: true}, wantPath: "/", wantSecure: true},
	}
	for _, tc := range tests {
		tc.opts.AuthToken = "tok"
		env := newTestEnvWith(t, tc.opts)
		prefix := strings.TrimSuffix(tc.wantPath, "/")
		env.do(t, http.MethodGet, prefix+"/?token=tok", "")
		if rec := env.do(t, http.MethodPost, prefix+"/api/connect", `{"profile":"dev"}`); rec.Code != http.StatusOK {
			t.Fatalf("%s: connect = %d %s, want 200", tc.name, rec.Code, rec.Body)
		}
		for _, name := range []string{tokenCookie, sessionCookie} {
			var c *http.Cookie
			for _, ec := range env.cookies {
				if ec.Name == name {
					c = ec
				}
			}
			if c == nil {
				t.Errorf("%s: no %s cookie set", tc.name, name)
				continue
			}
			if c.Path != tc.wantPath || c.Secure != tc.wantSecure {
				t.Errorf("%s: cookie %s Path, Secure = %q, %v, want %q, %v", tc.name, name, c.Path, c.Secure, tc.wantPath, tc.wantSecure)
			}
		}
	}
}

func TestWiring(t *testing.T) {
	env := newTestEnv(t)

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Host = "10.0.0.5:8080" // kubelet probes use the pod IP
	rec := httptest.NewRecorder()
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("healthz from pod IP = %d, want 200", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/profiles", nil)
	req.Host = "10.0.0.5:8080"
	rec = httptest.NewRecorder()
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("api from unknown host = %d, want 403", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/connect", strings.NewReader(`{"profile":"dev"}`))
	req.Host = "localhost:8080"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec = httptest.NewRecorder()
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("cross-site POST = %d, want 403", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/connect", strings.NewReader("profile=dev"))
	req.Host = "localhost:8080"
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec = httptest.NewRecorder()
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("form POST = %d, want 415", rec.Code)
	}
}
