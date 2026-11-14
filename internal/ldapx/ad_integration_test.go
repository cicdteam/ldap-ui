// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

//go:build integration

package ldapx

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"
	"github.com/google/go-cmp/cmp"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/cicdteam/ldap-ui/internal/ad"
	"github.com/cicdteam/ldap-ui/internal/profile"
)

const (
	adImage     = "smblds/smblds@sha256:af3586e5b73b159556af30b77bb73207cb60253e4281b698c58d6a846a3061f8"
	adBase      = "DC=corp,DC=example,DC=test"
	adAdminDN   = "CN=Administrator,CN=Users," + adBase
	adAdminPass = "Adm1nPassw0rd!"
	adOU        = "OU=ldapui," + adBase
	adUsers     = 1600
)

// adLDAPS and adLDAP are the Samba AD server's ldaps:// and ldap:// URLs.
var adLDAPS, adLDAP string

func adUserDN(i int) string { return fmt.Sprintf("CN=u%04d,%s", i, adOU) }

func adGroupDN(name string) string { return "CN=" + name + "," + adOU }

// startSamba starts Samba AD with the test CA's certificate and seeds it.
// It returns the container for termination even when it fails later, and an
// error carries the tail of the container log.
func startSamba(ctx context.Context) (_ testcontainers.Container, err error) {
	cert := func(name string) testcontainers.ContainerFile {
		return testcontainers.ContainerFile{
			HostFilePath: "../../deploy/ad-test/tls/" + name, ContainerFilePath: "/certs/" + name, FileMode: 0o644,
		}
	}
	ctr, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        adImage,
			ExposedPorts: []string{"636/tcp", "389/tcp"},
			Env:          map[string]string{"REALM": "CORP.EXAMPLE.TEST", "DOMAIN": "CORP", "ADMINPASS": adAdminPass},
			Files: []testcontainers.ContainerFile{
				{HostFilePath: "../../deploy/ad-test/10-tls.sh", ContainerFilePath: "/entrypoint.d/10-tls.sh", FileMode: 0o755},
				cert("ca.pem"), cert("cert.pem"), cert("key.pem"),
			},
			WaitingFor: wait.ForLog("samba version").WithStartupTimeout(2 * time.Minute),
		},
		Started: true,
	})
	if ctr != nil {
		defer func() { err = withLogTail(ctx, ctr, err) }()
	}
	if err != nil {
		return ctr, fmt.Errorf("start samba: %w", err)
	}
	// 127.0.0.1, not the container host: the certificate is issued for it.
	url := func(scheme, port string) (string, error) {
		p, err := ctr.MappedPort(ctx, port)
		if err != nil {
			return "", fmt.Errorf("samba port %s: %w", port, err)
		}
		return scheme + "://127.0.0.1:" + p.Port(), nil
	}
	if adLDAPS, err = url("ldaps", "636/tcp"); err != nil {
		return ctr, err
	}
	if adLDAP, err = url("ldap", "389/tcp"); err != nil {
		return ctr, err
	}
	c, err := waitForBind(ctx)
	if err != nil {
		return ctr, err
	}
	defer c.Close()
	return ctr, seedAD(ctx, c)
}

// waitForBind dials Samba until the Administrator bind works: the "samba
// version" log line can precede the LDAP listener. Invalid credentials fail
// at once, as waiting does not fix them.
func waitForBind(ctx context.Context) (*Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	for {
		c, err := Dial(ctx, adProfile(adLDAPS, false), adAdminPass)
		if err == nil {
			return c, nil
		}
		if ldap.IsErrorWithCode(err, ldap.LDAPResultInvalidCredentials) {
			return nil, fmt.Errorf("bind to samba: %w", err)
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("bind to samba: %w", err)
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// seedAD adds adOU with adUsers users, the group big with all of them as
// members, and inner (u0001) nested in outer.
func seedAD(ctx context.Context, c *Conn) error {
	add := func(dn string, attrs ...TextAttribute) error {
		if err := c.Add(ctx, dn, attrs); err != nil {
			return fmt.Errorf("seed samba: add %s: %w", dn, err)
		}
		return nil
	}
	attr := func(name string, values ...string) TextAttribute { return TextAttribute{Name: name, Values: values} }
	if err := add(adOU, attr("objectClass", "organizationalUnit"), attr("ou", "ldapui")); err != nil {
		return err
	}
	var members []string
	for i := 1; i <= adUsers; i++ {
		if err := add(adUserDN(i), attr("objectClass", "user"), attr("sAMAccountName", fmt.Sprintf("u%04d", i))); err != nil {
			return err
		}
		members = append(members, adUserDN(i))
	}
	groups := []struct {
		name    string
		members []string
	}{
		{name: "big", members: members}, // one Add request with every member
		{name: "inner", members: []string{adUserDN(1)}},
		{name: "outer", members: []string{adGroupDN("inner")}},
	}
	for _, g := range groups {
		err := add(adGroupDN(g.name), attr("objectClass", "group"), attr("sAMAccountName", g.name), attr("member", g.members...))
		if err != nil {
			return err
		}
	}
	return nil
}

// adProfile is the Administrator's profile for url, trusting the test CA.
func adProfile(url string, startTLS bool) profile.Profile {
	return profile.Profile{
		Name: "ad", URL: url, StartTLS: startTLS, BindDN: adAdminDN,
		CAFile:         "../../deploy/ad-test/tls/ca.pem",
		ConnectTimeout: 10 * time.Second, SearchTimeout: 30 * time.Second,
	}
}

// dialAD connects to Samba AD as Administrator over LDAPS.
func dialAD(t *testing.T) *Conn {
	t.Helper()
	c, err := Dial(context.Background(), adProfile(adLDAPS, false), adAdminPass)
	if err != nil {
		t.Fatalf("Dial(%s) error = %v", adLDAPS, err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestADDialLDAPS(t *testing.T) {
	info := dialAD(t).Info()
	if !info.ActiveDirectory || !info.Encrypted || info.BaseDN != adBase {
		t.Errorf("Info() = %+v, want AD, encrypted, base %s", info, adBase)
	}
}

func TestADDialWithoutCA(t *testing.T) {
	p := adProfile(adLDAPS, false)
	p.CAFile = ""
	_, err := Dial(context.Background(), p, adAdminPass)
	var u *UntrustedCertError
	if !errors.As(err, &u) || len(u.Certificates) == 0 {
		t.Fatalf("Dial(no CA) error = %v, want UntrustedCertError with the chain", err)
	}
	if got := u.Certificates[0].Subject.CommonName; got != "localhost" {
		t.Errorf("leaf CN = %q, want localhost", got)
	}
}

func TestADStartTLS(t *testing.T) {
	c, err := Dial(context.Background(), adProfile(adLDAP, true), adAdminPass)
	if err != nil {
		t.Fatalf("Dial(StartTLS) error = %v", err)
	}
	defer c.Close()
	if !c.Info().Encrypted {
		t.Error("Info().Encrypted = false over StartTLS")
	}
}

func TestADPlainBindRefused(t *testing.T) {
	_, err := Dial(context.Background(), adProfile(adLDAP, false), adAdminPass)
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultStrongAuthRequired) {
		t.Errorf("Dial(plain ldap) error = %v, want strongAuthRequired", err)
	}
}

func TestADSchemaAndSearch(t *testing.T) {
	c := dialAD(t)
	s, err := c.Schema(context.Background())
	if err != nil || s == nil {
		t.Fatalf("Schema() = %v, %v", s, err)
	}
	if _, ok := s.ObjectClass("user"); !ok {
		t.Error("Schema().ObjectClass(user) not found, want the AD schema")
	}
	page, err := c.Search(context.Background(), SearchRequest{BaseDN: adBase, Filter: "(sAMAccountName=u0001)"})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(page.Entries) != 1 || !strings.EqualFold(page.Entries[0].DN, adUserDN(1)) {
		t.Errorf("Search(sAMAccountName=u0001) = %v, want one entry %s", page.Entries, adUserDN(1))
	}
}

// attrValues returns the values of attr in e, or nil.
func attrValues(e Entry, attr string) []Value {
	for _, a := range e.Attributes {
		if strings.EqualFold(a.Name, attr) {
			return a.Values
		}
	}
	return nil
}

func TestADDecodedValues(t *testing.T) {
	e, err := dialAD(t).Entry(context.Background(), adUserDN(1))
	if err != nil {
		t.Fatalf("Entry() error = %v", err)
	}
	checks := []struct {
		attr string
		ok   func(Value) bool
		want string
	}{
		{attr: "objectSid", ok: func(v Value) bool { return strings.HasPrefix(v.Display, "S-1-5-21-") }, want: "S-1-5-21-..."},
		{attr: "objectGUID", ok: func(v Value) bool { return guidPattern.MatchString(v.Display) }, want: "a canonical GUID"},
		{attr: "whenCreated", ok: func(v Value) bool { return isRFC3339(v.Display) }, want: "an RFC 3339 time"},
		// u0001 has no password, so AD keeps pwdLastSet at 0.
		{attr: "pwdLastSet", ok: func(v Value) bool { return v.Display == "must change at next logon" }, want: "must change at next logon"},
		{attr: "userAccountControl", ok: func(v Value) bool {
			return strings.Contains(v.Display, "ACCOUNTDISABLE") && strings.Contains(v.Display, "PASSWD_NOTREQD")
		}, want: "ACCOUNTDISABLE and PASSWD_NOTREQD"},
	}
	for _, c := range checks {
		vs := attrValues(e, c.attr)
		if len(vs) != 1 || !c.ok(vs[0]) {
			t.Errorf("%s = %+v, want %s", c.attr, vs, c.want)
		}
	}
}

var guidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func isRFC3339(s string) bool {
	_, err := time.Parse(time.RFC3339, s)
	return err == nil
}

func TestADNestedMemberOf(t *testing.T) {
	m, err := dialAD(t).MemberOf(context.Background(), adUserDN(1), true)
	if err != nil {
		t.Fatalf("MemberOf() error = %v", err)
	}
	got := map[string]string{}
	for _, r := range m.Refs {
		got[strings.ToLower(r.DN)] = strings.ToLower(r.Via)
	}
	want := map[string]string{
		strings.ToLower(adGroupDN("big")):   "",
		strings.ToLower(adGroupDN("inner")): "",
		strings.ToLower(adGroupDN("outer")): strings.ToLower(adGroupDN("inner")),
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("MemberOf(u0001, nested) mismatch (-want +got):\n%s", diff)
	}
}

func TestADBigGroup(t *testing.T) {
	e, err := dialAD(t).Entry(context.Background(), adGroupDN("big"))
	if err != nil {
		t.Fatalf("Entry(big) error = %v", err)
	}
	if n := len(attrValues(e, "member")); n != adUsers {
		t.Errorf("Entry(big) has %d members, want %d", n, adUsers)
	}
}

// TestADCompleteRanges starts from a ranged first chunk that it asks for:
// Samba does not range a plain read (AD does, above MaxValRange), so this is
// how completeRanges gets to send follow-up requests.
func TestADCompleteRanges(t *testing.T) {
	c := dialAD(t)
	ctx := context.Background()
	e, err := c.rawEntry(ctx, adGroupDN("big"), []string{"member;range=0-99"})
	if err != nil {
		t.Fatalf("rawEntry(member;range=0-99) error = %v", err)
	}
	var names []string
	for _, a := range e.Attributes {
		names = append(names, a.Name)
	}
	if len(names) != 1 || names[0] != "member;range=0-99" {
		t.Fatalf("first chunk attributes = %q, want [member;range=0-99]", names)
	}
	first := slices.Clone(e.Attributes[0].Values)
	if len(first) != 100 {
		t.Fatalf("first chunk has %d values, want 100", len(first))
	}
	if err := completeRanges(e, c.rangeFetcher(ctx, adGroupDN("big"))); err != nil {
		t.Fatalf("completeRanges() error = %v", err)
	}
	got := e.Attributes[0]
	seen := map[string]bool{}
	for _, v := range got.Values {
		seen[strings.ToLower(v)] = true
	}
	if got.Name != "member" || len(got.Values) != adUsers || len(seen) != adUsers {
		t.Fatalf("completeRanges() = %s with %d values (%d distinct), want member with %d distinct values",
			got.Name, len(got.Values), len(seen), adUsers)
	}
	// The values come in the order of the chunks.
	if diff := cmp.Diff(first, got.Values[:len(first)]); diff != "" {
		t.Errorf("completeRanges() does not start with the first chunk (-want +got):\n%s", diff)
	}
}

func TestADModify(t *testing.T) {
	c := dialAD(t)
	ctx := context.Background()
	dn := adUserDN(2)
	description := func() []Value {
		t.Helper()
		e, err := c.Entry(ctx, dn)
		if err != nil {
			t.Fatalf("Entry() error = %v", err)
		}
		return attrValues(e, "description")
	}
	if err := c.Modify(ctx, dn, []Change{{Op: "add", Attr: "description", Values: []string{"edited by ldapui"}}}); err != nil {
		t.Fatalf("Modify(add) error = %v", err)
	}
	t.Cleanup(func() { // runs before dialAD's Close
		if err := c.Modify(ctx, dn, []Change{{Op: "delete", Attr: "description"}}); err != nil {
			t.Errorf("Modify(delete description) error = %v", err)
		}
	})
	if vs := description(); len(vs) != 1 || vs[0].Text != "edited by ldapui" {
		t.Errorf("description after add = %+v, want [edited by ldapui]", vs)
	}
	// The UI changes a value as a delete of the old one plus an add.
	edit := []Change{
		{Op: "delete", Attr: "description", Values: []string{"edited by ldapui"}},
		{Op: "add", Attr: "description", Values: []string{"edited again"}},
	}
	if err := c.Modify(ctx, dn, edit); err != nil {
		t.Fatalf("Modify(edit) error = %v", err)
	}
	if vs := description(); len(vs) != 1 || vs[0].Text != "edited again" {
		t.Errorf("description after edit = %+v, want [edited again]", vs)
	}
}

func TestADSetPassword(t *testing.T) {
	c := dialAD(t)
	ctx := context.Background()
	dn := adUserDN(3)
	err := c.SetPassword(ctx, dn, "x", "")
	if err == nil || ad.PasswordReason(err.Error()) == "" {
		t.Fatalf("SetPassword(too short) error = %v, want 0000052D", err)
	}
	// Long enough but not complex, and distinctive, so an echo of it in
	// the error shows.
	const weak = "qzqzqzqzqzqz"
	err = c.SetPassword(ctx, dn, weak, "")
	if err == nil || ad.PasswordReason(err.Error()) == "" {
		t.Fatalf("SetPassword(not complex) error = %v, want 0000052D", err)
	}
	if strings.Contains(err.Error(), weak) {
		t.Errorf("SetPassword error %q carries the password", err)
	}
	const good = "G00d-Passw0rd!"
	if err := c.SetPassword(ctx, dn, good, ""); err != nil {
		t.Fatalf("SetPassword(valid) error = %v", err)
	}
	e, err := c.Entry(ctx, dn)
	if err != nil {
		t.Fatalf("Entry() error = %v", err)
	}
	if vs := attrValues(e, "pwdLastSet"); len(vs) != 1 || !isRFC3339(vs[0].Display) {
		t.Errorf("pwdLastSet after SetPassword = %+v, want an RFC 3339 time", vs)
	}
	if err := c.Modify(ctx, dn, []Change{{Op: "replace", Attr: "userAccountControl", Values: []string{"512"}}}); err != nil {
		t.Fatalf("enable account: %v", err)
	}
	p := adProfile(adLDAPS, false)
	p.BindDN = dn
	u, err := Dial(ctx, p, good)
	if err != nil {
		t.Fatalf("Dial(as %s) error = %v", dn, err)
	}
	_ = u.Close()
}
