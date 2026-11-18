// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

//go:build integration

package ldapx

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"log"
	"math/big"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"
	"github.com/google/go-cmp/cmp"
	"github.com/testcontainers/testcontainers-go"
	tclog "github.com/testcontainers/testcontainers-go/log"
	"github.com/testcontainers/testcontainers-go/modules/openldap"

	"github.com/cicdteam/ldaplens/internal/profile"
	"github.com/cicdteam/ldaplens/internal/schema"
)

const (
	openLDAPImage = "bitnamilegacy/openldap:2.6.10@sha256:687f14a22b5c74fb057a57221acdbe7b8c82e2d3619fc380db3af48ec4aa04ed"
	testBase      = "dc=example,dc=org"
	testPeople    = "ou=people," + testBase
	testGroups    = "ou=groups," + testBase
	testUsers     = 2000
	testBigGroup  = testUsers
	// testSpecialDN has an escaped comma, a slash and non-ASCII text.
	testSpecialDN = `cn=Smith\, John/Jr Ünal,` + "ou=people," + testBase
)

var testURL string

func TestMain(m *testing.M) { os.Exit(runWithServers(m)) }

// runWithServers starts OpenLDAP and Samba AD side by side, runs the tests
// and terminates both.
func runWithServers(m *testing.M) int {
	tclog.SetDefault(tclog.NewNoopLogger())
	// A failed start cancels the other one: the run fails either way.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var (
		wg              sync.WaitGroup
		openLDAP, samba testcontainers.Container
		ldapErr, adErr  error
	)
	wg.Go(func() {
		if openLDAP, ldapErr = startOpenLDAP(ctx); ldapErr != nil {
			cancel()
		}
	})
	wg.Go(func() {
		if samba, adErr = startSamba(ctx); adErr != nil {
			cancel()
		}
	})
	wg.Wait()
	defer func() { _ = testcontainers.TerminateContainer(openLDAP) }()
	defer func() { _ = testcontainers.TerminateContainer(samba) }()
	if err := errors.Join(ldapErr, adErr); err != nil {
		log.Printf("start test servers: %v", err)
		return 1
	}
	return m.Run()
}

// startOpenLDAP starts OpenLDAP and seeds it with seedLDIF. It returns the
// container for termination even when it fails later, and an error carries
// the tail of the container log.
func startOpenLDAP(ctx context.Context) (_ testcontainers.Container, err error) {
	// The seed owns the whole tree: since 2.6.10 the image's default tree has
	// an ou=groups of its own.
	ctr, err := openldap.Run(ctx, openLDAPImage,
		testcontainers.WithEnv(map[string]string{"LDAP_SKIP_DEFAULT_TREE": "yes"}))
	if ctr != nil {
		defer func() { err = withLogTail(ctx, ctr, err) }()
	}
	if err != nil {
		return ctr, fmt.Errorf("start openldap: %w", err)
	}
	if testURL, err = ctr.ConnectionString(ctx); err != nil {
		return ctr, fmt.Errorf("openldap url: %w", err)
	}
	if err := ctr.LoadLdif(ctx, []byte(seedLDIF())); err != nil {
		return ctr, fmt.Errorf("seed openldap: %w", err)
	}
	return ctr, nil
}

// withLogTail adds the last 50 lines of ctr's log to err, the error of a
// failed start, so that a CI log shows what the server said. The log is
// read even when ctx is done, as it is after a cancelled start.
func withLogTail(ctx context.Context, ctr testcontainers.Container, err error) error {
	if err == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	rc, logErr := ctr.Logs(ctx)
	if logErr != nil {
		return fmt.Errorf("%w (container log: %w)", err, logErr)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc) // ponytail: a log cut short by a read error still helps
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	lines = lines[max(0, len(lines)-50):]
	return fmt.Errorf("%w\ncontainer log, last %d lines:\n%s", err, len(lines), strings.Join(lines, "\n"))
}

func userDN(i int) string { return fmt.Sprintf("uid=user%05d,%s", i, testPeople) }

func groupDN(name string) string { return "cn=" + name + "," + testGroups }

// writeLDIF writes the LDIF record of dn with lines, its "attr: value"
// lines, to b.
func writeLDIF(b *strings.Builder, dn string, lines ...string) {
	fmt.Fprintf(b, "dn: %s\n%s\n\n", dn, strings.Join(lines, "\n"))
}

// seedLDIF builds the test tree: testUsers people, a group with testBigGroup
// members, a two-level nested group, a membership cycle, an entry with a DN
// that needs escaping and a posixGroup.
func seedLDIF() string {
	var b strings.Builder
	entry := func(dn string, lines ...string) { writeLDIF(&b, dn, lines...) }
	entry(testBase, "objectClass: dcObject", "objectClass: organization", "dc: example", "o: example")
	entry(testPeople, "objectClass: organizationalUnit", "ou: people")
	entry(testGroups, "objectClass: organizationalUnit", "ou: groups")
	for i := range testUsers {
		entry(userDN(i), "objectClass: inetOrgPerson",
			fmt.Sprintf("uid: user%05d", i), fmt.Sprintf("cn: User %05d", i), fmt.Sprintf("sn: %05d", i),
			fmt.Sprintf("mail: user%05d@example.org", i), fmt.Sprintf("userPassword: secret%05d", i))
	}
	// LDIF requires base64 ("attr:: ") for values with non-ASCII bytes.
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	fmt.Fprintf(&b, "dn:: %s\nobjectClass: person\ncn:: %s\nsn: Smith\n\n", b64(testSpecialDN), b64("Smith, John/Jr Ünal"))

	big := []string{"objectClass: groupOfNames", "cn: big"}
	for i := range testBigGroup {
		big = append(big, "member: "+userDN(i))
	}
	entry(groupDN("big"), big...)
	entry(groupDN("inner"), "objectClass: groupOfNames", "cn: inner", "member: "+userDN(0))
	entry(groupDN("outer"), "objectClass: groupOfNames", "cn: outer", "member: "+groupDN("inner"))
	entry(groupDN("cycle-a"), "objectClass: groupOfNames", "cn: cycle-a", "member: "+groupDN("cycle-b"), "member: "+userDN(1))
	entry(groupDN("cycle-b"), "objectClass: groupOfNames", "cn: cycle-b", "member: "+groupDN("cycle-a"))
	entry(groupDN("special"), "objectClass: groupOfNames", "cn: special", "member:: "+b64(testSpecialDN))
	entry(groupDN("posix"), "objectClass: posixGroup", "cn: posix", "gidNumber: 7000", "memberUid: user00002")
	return b.String()
}

func testProfile() profile.Profile {
	return profile.Profile{
		Name: "test", URL: testURL, BindDN: "cn=admin," + testBase,
		ConnectTimeout: 10 * time.Second, SearchTimeout: 30 * time.Second,
	}
}

func dialAdmin(t *testing.T) *Conn {
	t.Helper()
	c, err := Dial(context.Background(), testProfile(), "adminpassword")
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestDialInfo(t *testing.T) {
	info := dialAdmin(t).Info()
	if info.BaseDN != testBase || !info.Paging || info.ActiveDirectory || !info.PasswordModify || info.Encrypted {
		t.Errorf("Info() = %+v, want base %s, paging, Password Modify, not AD, not encrypted", info, testBase)
	}
}

func TestDialWrongPassword(t *testing.T) {
	_, err := Dial(context.Background(), testProfile(), "wrong")
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultInvalidCredentials) {
		t.Errorf("Dial(wrong password) error = %v, want invalidCredentials", err)
	}
}

// asUser turns p into a profile with bindDNTemplate template and sets its
// BindDN to what BindDNFor resolves for username, as the connect handler
// does before it dials.
func asUser(t *testing.T, p profile.Profile, template, username string) profile.Profile {
	t.Helper()
	p.BindDN, p.BindDNTemplate = "", template
	dn, err := p.BindDNFor(username)
	if err != nil {
		t.Fatalf("BindDNFor(%q) error = %v", username, err)
	}
	p.BindDN = dn
	return p
}

// TestTemplateBindOpenLDAP adds user001 of the demo data, as the seed
// numbers its people differently, and signs in as it through a template.
func TestTemplateBindOpenLDAP(t *testing.T) {
	const dn = "uid=user001,ou=people,dc=example,dc=org"
	admin := dialAdmin(t)
	ctx := context.Background()
	attrs := append(personAttrs("user001"), TextAttribute{Name: "userPassword", Values: []string{"secret001"}})
	if err := admin.Add(ctx, dn, attrs); err != nil {
		t.Fatalf("Add(%s) error = %v", dn, err)
	}
	t.Cleanup(func() { // runs before dialAdmin's Close
		if err := admin.Delete(ctx, dn); err != nil {
			t.Errorf("Delete(%s) error = %v", dn, err)
		}
	})
	p := asUser(t, testProfile(), "uid={user},ou=people,dc=example,dc=org", "user001")

	c, err := Dial(ctx, p, "secret001")
	if err != nil {
		t.Fatalf("Dial(as user001) error = %v", err)
	}
	defer c.Close()
	if got := c.Info().BindDN; got != dn {
		t.Errorf("Info().BindDN = %q, want %q", got, dn)
	}
	if _, err := Dial(ctx, p, "secret002"); !ldap.IsErrorWithCode(err, ldap.LDAPResultInvalidCredentials) {
		t.Errorf("Dial(as user001, wrong password) error = %v, want invalidCredentials", err)
	}
	// RFC 4513 treats a DN with an empty password as an unauthenticated
	// bind; go-ldap refuses to send one.
	if got, err := Dial(ctx, p, ""); got != nil || !ldap.IsErrorWithCode(err, ldap.ErrorEmptyPassword) {
		if got != nil {
			_ = got.Close()
		}
		t.Errorf("Dial(as user001, empty password) = %v, %v, want no connection and ErrorEmptyPassword", got, err)
	}
}

func TestSchemaFromServer(t *testing.T) {
	s, err := dialAdmin(t).Schema(context.Background())
	if err != nil {
		t.Fatalf("Schema() error = %v", err)
	}
	if objectClass(s, "inetOrgPerson") == nil {
		t.Error("Schema() has no inetOrgPerson class")
	}
	if oc := objectClass(s, "person"); oc == nil || !slices.Contains(oc.Must, "cn") || !slices.Contains(oc.Must, "sn") {
		t.Errorf("Schema() person = %+v, want MUST cn and sn", oc)
	}
	if got, want := s.Syntax("member"), "1.3.6.1.4.1.1466.115.121.1.12"; got != want {
		t.Errorf("Syntax(member) = %q, want the DN syntax %q", got, want)
	}
	if len(s.Skipped) != 0 {
		t.Errorf("Schema() skipped %q, want every definition parsed", s.Skipped)
	}
}

// objectClass returns the class s publishes under name, or nil.
func objectClass(s *schema.Schema, name string) *schema.ObjectClass {
	for _, oc := range s.ObjectClasses {
		if slices.Contains(oc.Names, name) {
			return oc
		}
	}
	return nil
}

// TestSearchStopsAtLimit checks that a search with more matches than its
// size limit stops at the limit and reports more, whether the limit spans
// several pages or ends inside the first.
func TestSearchStopsAtLimit(t *testing.T) {
	c := dialAdmin(t)
	tests := []struct {
		name      string
		pageSize  int
		sizeLimit int
	}{
		{name: "over several pages", pageSize: 500, sizeLimit: 1500},
		{name: "inside the first page", pageSize: 100, sizeLimit: 10},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p, err := c.Search(context.Background(), peopleListing(tc.pageSize, tc.sizeLimit))
			if err != nil {
				t.Fatalf("Search(sizeLimit %d) error = %v", tc.sizeLimit, err)
			}
			if len(p.Entries) != tc.sizeLimit || !p.More || p.Truncated {
				t.Errorf("Search(sizeLimit %d) = %d entries, more %v, truncated %v; want %d, more, not truncated",
					tc.sizeLimit, len(p.Entries), p.More, p.Truncated, tc.sizeLimit)
			}
		})
	}
}

// TestSearchPagesToEnd checks that a search with fewer matches than its size
// limit returns all of them, over several pages, without more.
func TestSearchPagesToEnd(t *testing.T) {
	req := SearchRequest{BaseDN: testPeople, Scope: ScopeOne, Filter: "(uid=user01*)", Attributes: []string{"uid"}, PageSize: 300, SizeLimit: 5000}
	p, err := dialAdmin(t).Search(context.Background(), req)
	if err != nil {
		t.Fatalf("Search(%s) error = %v", req.Filter, err)
	}
	if len(p.Entries) != 1000 || p.More || p.Truncated {
		t.Errorf("Search(%s) = %d entries, more %v, truncated %v; want 1000, neither more nor truncated", req.Filter, len(p.Entries), p.More, p.Truncated)
	}
}

func TestSearchWithoutPaging(t *testing.T) {
	c := dialAdmin(t)
	c.info.Paging = false // pretend the server lacks the paging control
	p, err := c.Search(context.Background(), peopleListing(1000, 100))
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(p.Entries) != 100 || !p.More || p.Truncated {
		t.Errorf("Search(no paging, sizeLimit 100) = %d entries, more %v, truncated %v; want 100, more, not truncated", len(p.Entries), p.More, p.Truncated)
	}
}

// TestSearchSecretFilter checks that Conn.Search refuses a filter matching
// on a secret value before the server sees it, and lets presence through.
func TestSearchSecretFilter(t *testing.T) {
	c := dialAdmin(t)
	_, err := c.Search(context.Background(), SearchRequest{BaseDN: testBase, Filter: "(userPassword=x*)"})
	if !errors.Is(err, ErrSecretFilter) {
		t.Errorf("Search((userPassword=x*)) error = %v, want ErrSecretFilter", err)
	}
	if _, err := c.Search(context.Background(), SearchRequest{BaseDN: testBase, Filter: "(userPassword=*)"}); err != nil {
		t.Errorf("Search((userPassword=*)) error = %v, want nil", err)
	}
}

func TestEntry(t *testing.T) {
	e, err := dialAdmin(t).Entry(context.Background(), userDN(0))
	if err != nil {
		t.Fatalf("Entry() error = %v", err)
	}
	attrs := map[string]Attribute{}
	for _, a := range e.Attributes {
		attrs[a.Name] = a
	}
	if pw := attrs["userPassword"]; pw.Masked != 1 || len(pw.Values) != 0 {
		t.Errorf("Entry().userPassword = %+v, want masked with no values", pw)
	}
	if mail := attrs["mail"]; len(mail.Values) != 1 || mail.Values[0].Text != "user00000@example.org" {
		t.Errorf("Entry().mail = %+v, want user00000@example.org", mail)
	}
	if ts := attrs["createTimestamp"]; len(ts.Values) != 1 || ts.Values[0].Display == "" {
		t.Errorf("Entry().createTimestamp = %+v, want an operational attribute with a display date", ts)
	}
}

func TestEntryNotFound(t *testing.T) {
	_, err := dialAdmin(t).Entry(context.Background(), "uid=nobody,"+testPeople)
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchObject) {
		t.Errorf("Entry(missing) error = %v, want noSuchObject", err)
	}
}

func TestEntrySpecialDN(t *testing.T) {
	e, err := dialAdmin(t).Entry(context.Background(), testSpecialDN)
	if err != nil {
		t.Fatalf("Entry(%q) error = %v", testSpecialDN, err)
	}
	want, _ := ldap.ParseDN(testSpecialDN)
	if got, err := ldap.ParseDN(e.DN); err != nil || !want.EqualFold(got) {
		t.Errorf("Entry(%q).DN = %q, want the same DN", testSpecialDN, e.DN)
	}
}

func TestEntryBigGroup(t *testing.T) {
	e, err := dialAdmin(t).Entry(context.Background(), groupDN("big"))
	if err != nil {
		t.Fatalf("Entry(big) error = %v", err)
	}
	members := -1
	for _, a := range e.Attributes {
		if a.Name == "member" {
			members = len(a.Values)
		}
	}
	if members != testBigGroup {
		t.Errorf("Entry(big).member has %d values (-1: missing), want %d", members, testBigGroup)
	}
}

func TestReconnect(t *testing.T) {
	c := dialAdmin(t)
	lc, err := c.current(context.Background())
	if err != nil {
		t.Fatalf("current() error = %v", err)
	}
	_ = lc.Close() // simulate the server dropping the connection
	p, err := c.Search(context.Background(), SearchRequest{BaseDN: userDN(0), Scope: ScopeBase})
	if err != nil || len(p.Entries) != 1 {
		t.Errorf("Search() after drop = %d entries, %v, want 1 entry", len(p.Entries), err)
	}
}

// peopleListing lists the test users: at most sizeLimit of them,
// pageSize at a time.
func peopleListing(pageSize, sizeLimit int) SearchRequest {
	return SearchRequest{
		BaseDN: testPeople, Scope: ScopeOne, Filter: "(objectClass=inetOrgPerson)", Attributes: []string{"uid"},
		PageSize: pageSize, SizeLimit: sizeLimit,
	}
}

// TestSearchConcurrentWalks checks that searches running at once on one
// Conn each page on a connection of their own.
func TestSearchConcurrentWalks(t *testing.T) {
	c := dialAdmin(t)
	var wg sync.WaitGroup
	for i := range 3 {
		wg.Go(func() {
			p, err := c.Search(context.Background(), peopleListing(500, 1500))
			if err != nil || len(p.Entries) != 1500 || !p.More {
				t.Errorf("concurrent Search() %d = %d entries, more %v, %v; want 1500, more", i, len(p.Entries), p.More, err)
			}
		})
	}
	wg.Wait()
}

// TestSearchStoppedWalksKeepConnection checks that searches stopped at their
// limit abandon their paged searches and hand the connection back, so one
// server connection serves them all.
func TestSearchStoppedWalksKeepConnection(t *testing.T) {
	ctx := context.Background()
	c := dialAdmin(t)
	shared, err := c.current(ctx)
	if err != nil {
		t.Fatalf("current() error = %v", err)
	}
	for i := range 10 {
		p, err := c.Search(ctx, peopleListing(100, 100))
		if err != nil || len(p.Entries) != 100 || !p.More {
			t.Fatalf("Search(sizeLimit 100) %d = %d entries, more %v, %v; want 100, more", i, len(p.Entries), p.More, err)
		}
	}
	c.mu.Lock()
	now := c.lc
	c.mu.Unlock()
	if now != shared || shared.IsClosing() {
		t.Error("searches stopped at their limit replaced the shared connection, want it abandoned and handed back")
	}
}

func TestMemberOf(t *testing.T) {
	c := dialAdmin(t)
	tests := []struct {
		name   string
		dn     string
		nested bool
		want   []Ref
	}{
		{name: "direct", dn: userDN(0), want: []Ref{{DN: groupDN("big")}, {DN: groupDN("inner")}}},
		{name: "nested", dn: userDN(0), nested: true, want: []Ref{
			{DN: groupDN("big")}, {DN: groupDN("inner")}, {DN: groupDN("outer"), Via: groupDN("inner")},
		}},
		{name: "cycle terminates", dn: userDN(1), nested: true, want: []Ref{
			{DN: groupDN("big")}, {DN: groupDN("cycle-a")}, {DN: groupDN("cycle-b"), Via: groupDN("cycle-a")},
		}},
	}
	for _, tc := range tests {
		got, err := c.MemberOf(context.Background(), tc.dn, tc.nested)
		if err != nil {
			t.Errorf("%s: MemberOf() error = %v", tc.name, err)
			continue
		}
		if diff := cmp.Diff(tc.want, got.Refs, cmpSortRefs); diff != "" || got.Truncated {
			t.Errorf("%s: MemberOf(%s) truncated %v, mismatch (-want +got):\n%s", tc.name, tc.dn, got.Truncated, diff)
		}
	}
}

func TestMemberOfSpecialDN(t *testing.T) {
	got, err := dialAdmin(t).MemberOf(context.Background(), testSpecialDN, false)
	if err != nil {
		t.Fatalf("MemberOf(%q) error = %v", testSpecialDN, err)
	}
	if diff := cmp.Diff([]Ref{{DN: groupDN("special")}}, got.Refs, cmpSortRefs); diff != "" {
		t.Errorf("MemberOf(%q) mismatch (-want +got):\n%s", testSpecialDN, diff)
	}
}

func TestMembers(t *testing.T) {
	c := dialAdmin(t)
	big, err := c.Members(context.Background(), groupDN("big"), false)
	if err != nil || len(big.Refs) != testBigGroup || big.Truncated {
		t.Errorf("Members(big) = %d refs truncated %v, %v, want %d not truncated", len(big.Refs), big.Truncated, err, testBigGroup)
	}
	tests := []struct {
		group string
		want  []Ref
	}{
		{group: "outer", want: []Ref{{DN: groupDN("inner")}, {DN: userDN(0), Via: groupDN("inner")}}},
		// cycle-b lists cycle-a again, which is not repeated.
		{group: "cycle-a", want: []Ref{{DN: groupDN("cycle-b")}, {DN: userDN(1)}}},
	}
	for _, tc := range tests {
		got, err := c.Members(context.Background(), groupDN(tc.group), true)
		if err != nil {
			t.Errorf("Members(%s, nested) error = %v", tc.group, err)
			continue
		}
		if diff := cmp.Diff(tc.want, got.Refs, cmpSortRefs); diff != "" || got.Truncated {
			t.Errorf("Members(%s, nested) truncated %v, mismatch (-want +got):\n%s", tc.group, got.Truncated, diff)
		}
	}
}

// cmpSortRefs compares Ref slices ignoring order and DN case.
var cmpSortRefs = cmp.Transformer("normRefs", func(in []Ref) []string {
	out := make([]string, len(in))
	for i, r := range in {
		out[i] = strings.ToLower(r.DN + " via " + r.Via)
	}
	slices.Sort(out)
	return out
})

// TestMembershipScansHandBackConnection checks that a membership scan
// pages to the end below its limit and stops at its limit, and that a scan
// stopped early hands back a connection that pages again. A scan stopped
// at its limit reports truncation.
func TestMembershipScansHandBackConnection(t *testing.T) {
	ctx := context.Background()
	c := dialAdmin(t)
	if _, err := c.MemberOf(ctx, userDN(0), true); err != nil {
		t.Errorf("MemberOf(nested) error = %v", err)
	}
	if _, err := c.Members(ctx, groupDN("outer"), true); err != nil {
		t.Errorf("Members(nested) error = %v", err)
	}
	// The image seeds a few users of its own, hence "at least".
	if dns, truncated, err := c.allDNs(ctx, "(objectClass=inetOrgPerson)", maxGroupIndex); err != nil || len(dns) < testUsers || truncated {
		t.Errorf("allDNs(all users, limit %d) = %d DNs truncated %v, %v, want at least %d not truncated", maxGroupIndex, len(dns), truncated, err, testUsers)
	}
	if dns, truncated, err := c.allDNs(ctx, "(objectClass=inetOrgPerson)", 3); err != nil || len(dns) != 3 || !truncated {
		t.Errorf("allDNs(all users, limit 3) = %d DNs truncated %v, %v, want 3 truncated", len(dns), truncated, err)
	}
	c.mu.Lock()
	shared := c.lc
	c.mu.Unlock()
	if shared == nil {
		t.Error("allDNs stopped at its limit closed its connection, want it abandoned and shared again")
	}
	if p, err := c.Search(ctx, peopleListing(500, 1500)); err != nil || len(p.Entries) != 1500 || !p.More {
		t.Errorf("Search(sizeLimit 1500) after an abandoned scan = %d entries, more %v, %v; want 1500, more", len(p.Entries), p.More, err)
	}
}

func TestMembershipWithoutPaging(t *testing.T) {
	ctx := context.Background()
	c := dialAdmin(t)
	c.info.Paging = false // pretend the server lacks the paging control
	got, err := c.MemberOf(ctx, userDN(0), true)
	if err != nil {
		t.Fatalf("MemberOf(no paging) error = %v", err)
	}
	want := []Ref{{DN: groupDN("big")}, {DN: groupDN("inner")}, {DN: groupDN("outer"), Via: groupDN("inner")}}
	if diff := cmp.Diff(want, got.Refs, cmpSortRefs); diff != "" || got.Truncated {
		t.Errorf("MemberOf(no paging) truncated %v, mismatch (-want +got):\n%s", got.Truncated, diff)
	}
	if dns, truncated, err := c.allDNs(ctx, "(objectClass=inetOrgPerson)", 3); err != nil || len(dns) != 3 || !truncated {
		t.Errorf("allDNs(all users, limit 3, no paging) = %d DNs truncated %v, %v, want 3 truncated", len(dns), truncated, err)
	}
}

func valuesOf(t *testing.T, c *Conn, dn, attr string) []string {
	t.Helper()
	e, err := c.Entry(context.Background(), dn)
	if err != nil {
		t.Fatalf("Entry(%s) error = %v", dn, err)
	}
	var out []string
	for _, a := range e.Attributes {
		if strings.EqualFold(a.Name, attr) {
			for _, v := range a.Values {
				out = append(out, v.Text)
			}
		}
	}
	return out
}

func TestModifyReplaceValue(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	dn := userDN(1990)
	old := "user01990@example.org"
	err := c.Modify(ctx, dn, []Change{
		{Op: "delete", Attr: "mail", Values: []string{old}},
		{Op: "add", Attr: "mail", Values: []string{"new01990@example.org"}},
	})
	if err != nil {
		t.Fatalf("Modify() error = %v", err)
	}
	if diff := cmp.Diff([]string{"new01990@example.org"}, valuesOf(t, c, dn, "mail")); diff != "" {
		t.Errorf("mail after Modify (-want +got):\n%s", diff)
	}

	// The old value is gone: a stale edit fails and changes nothing.
	err = c.Modify(ctx, dn, []Change{
		{Op: "delete", Attr: "mail", Values: []string{old}},
		{Op: "add", Attr: "mail", Values: []string{"stale@example.org"}},
	})
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchAttribute) {
		t.Errorf("stale Modify() error = %v, want noSuchAttribute", err)
	}
	if diff := cmp.Diff([]string{"new01990@example.org"}, valuesOf(t, c, dn, "mail")); diff != "" {
		t.Errorf("mail after stale Modify (-want +got):\n%s", diff)
	}

	err = c.Modify(ctx, dn, []Change{{Op: "add", Attr: "mail", Values: []string{"new01990@example.org"}}})
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultAttributeOrValueExists) {
		t.Errorf("duplicate add error = %v, want attributeOrValueExists", err)
	}
}

func TestModifySingleValue(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	dn := userDN(1991)
	if err := c.Modify(ctx, dn, []Change{{Op: "add", Attr: "displayName", Values: []string{"A"}}}); err != nil {
		t.Fatalf("add displayName error = %v", err)
	}
	if err := c.Modify(ctx, dn, []Change{
		{Op: "delete", Attr: "displayName", Values: []string{"A"}},
		{Op: "add", Attr: "displayName", Values: []string{"B"}},
	}); err != nil {
		t.Fatalf("replace displayName error = %v", err)
	}
	err := c.Modify(ctx, dn, []Change{{Op: "add", Attr: "displayName", Values: []string{"C"}}})
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultConstraintViolation) {
		t.Errorf("second displayName error = %v, want constraintViolation", err)
	}
}

// writeOU adds an empty OU under testBase for one test's writes, away from
// the shared people listing, and returns its DN.
func writeOU(t *testing.T, c *Conn, name string) string {
	t.Helper()
	dn := "ou=" + name + "," + testBase
	if err := c.Add(context.Background(), dn, []TextAttribute{
		{Name: "objectClass", Values: []string{"organizationalUnit"}},
		{Name: "ou", Values: []string{name}},
	}); err != nil {
		t.Fatalf("Add(%s) error = %v", dn, err)
	}
	return dn
}

// personAttrs are the attributes of a minimal inetOrgPerson.
func personAttrs(uid string) []TextAttribute {
	return []TextAttribute{
		{Name: "objectClass", Values: []string{"inetOrgPerson"}},
		{Name: "uid", Values: []string{uid}},
		{Name: "cn", Values: []string{"Person " + uid}},
		{Name: "sn", Values: []string{uid}},
	}
}

func TestAdd(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	dn := "uid=added," + writeOU(t, c, "add")
	if err := c.Add(ctx, dn, personAttrs("added")); err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	if diff := cmp.Diff([]string{"Person added"}, valuesOf(t, c, dn, "cn")); diff != "" {
		t.Errorf("cn after Add (-want +got):\n%s", diff)
	}
	if err := c.Add(ctx, dn, personAttrs("added")); !ldap.IsErrorWithCode(err, ldap.LDAPResultEntryAlreadyExists) {
		t.Errorf("second Add() error = %v, want entryAlreadyExists", err)
	}
}

func TestDeleteLeafOnly(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	ou := writeOU(t, c, "delete")
	leaf := "uid=leaf," + ou
	if err := c.Add(ctx, leaf, personAttrs("leaf")); err != nil {
		t.Fatalf("Add(leaf) error = %v", err)
	}
	if err := c.Delete(ctx, ou); !ldap.IsErrorWithCode(err, ldap.LDAPResultNotAllowedOnNonLeaf) {
		t.Errorf("Delete(non-leaf) error = %v, want notAllowedOnNonLeaf", err)
	}
	if err := c.Delete(ctx, leaf); err != nil {
		t.Fatalf("Delete(leaf) error = %v", err)
	}
	if _, err := c.Entry(ctx, leaf); !ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchObject) {
		t.Errorf("Entry(deleted) error = %v, want noSuchObject", err)
	}
	if err := c.Delete(ctx, ou); err != nil {
		t.Errorf("Delete(emptied OU) error = %v", err)
	}
}

func TestRename(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	from := writeOU(t, c, "rename-from")
	to := writeOU(t, c, "rename-to")
	if err := c.Add(ctx, "uid=old,"+from, personAttrs("old")); err != nil {
		t.Fatalf("Add() error = %v", err)
	}

	// Within the parent; deleteOld drops the old RDN value.
	if err := c.Rename(ctx, "uid=old,"+from, "uid=new", "", true); err != nil {
		t.Fatalf("Rename() error = %v", err)
	}
	if diff := cmp.Diff([]string{"new"}, valuesOf(t, c, "uid=new,"+from, "uid")); diff != "" {
		t.Errorf("uid after Rename (-want +got):\n%s", diff)
	}

	// To another parent.
	if err := c.Rename(ctx, "uid=new,"+from, "uid=new", to, true); err != nil {
		t.Fatalf("Rename(move) error = %v", err)
	}
	if _, err := c.Entry(ctx, "uid=new,"+to); err != nil {
		t.Errorf("Entry(moved) error = %v", err)
	}
	if _, err := c.Entry(ctx, "uid=new,"+from); !ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchObject) {
		t.Errorf("Entry(old place) error = %v, want noSuchObject", err)
	}

	// Without deleteOld the old value stays next to the new one.
	if err := c.Rename(ctx, "uid=new,"+to, "uid=newer", "", false); err != nil {
		t.Fatalf("Rename(keep old) error = %v", err)
	}
	got := valuesOf(t, c, "uid=newer,"+to, "uid")
	slices.Sort(got)
	if diff := cmp.Diff([]string{"new", "newer"}, got); diff != "" {
		t.Errorf("uid after Rename(keep old) (-want +got):\n%s", diff)
	}
}

func TestModifyAuxiliaryClass(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	dn := "uid=aux," + writeOU(t, c, "aux")
	if err := c.Add(ctx, dn, personAttrs("aux")); err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	posix := []Change{
		{Op: "add", Attr: "objectClass", Values: []string{"posixAccount"}},
		{Op: "add", Attr: "uidNumber", Values: []string{"5000"}},
		{Op: "add", Attr: "gidNumber", Values: []string{"5000"}},
		{Op: "add", Attr: "homeDirectory", Values: []string{"/home/aux"}},
	}
	// Without its MUST attributes the class is refused, and nothing changes.
	if err := c.Modify(ctx, dn, posix[:1]); !ldap.IsErrorWithCode(err, ldap.LDAPResultObjectClassViolation) {
		t.Errorf("Modify(class only) error = %v, want objectClassViolation", err)
	}
	if err := c.Modify(ctx, dn, posix); err != nil {
		t.Fatalf("Modify(add posixAccount) error = %v", err)
	}
	if diff := cmp.Diff([]string{"inetOrgPerson", "posixAccount"}, valuesOf(t, c, dn, "objectClass")); diff != "" {
		t.Errorf("objectClass after add (-want +got):\n%s", diff)
	}
	remove := make([]Change, len(posix))
	for i, ch := range posix {
		remove[i] = Change{Op: "delete", Attr: ch.Attr, Values: ch.Values}
	}
	if err := c.Modify(ctx, dn, remove); err != nil {
		t.Fatalf("Modify(remove posixAccount) error = %v", err)
	}
	if diff := cmp.Diff([]string{"inetOrgPerson"}, valuesOf(t, c, dn, "objectClass")); diff != "" {
		t.Errorf("objectClass after remove (-want +got):\n%s", diff)
	}
}

func TestSetPassword(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	ou := writeOU(t, c, "password")
	for _, method := range []string{"server", "ssha"} {
		t.Run(method, func(t *testing.T) {
			dn := "uid=" + method + "," + ou
			if err := c.Add(ctx, dn, personAttrs(method)); err != nil {
				t.Fatalf("Add(%s) error = %v", dn, err)
			}
			// Spaces and non-ASCII letters reach the server as typed.
			typed := " N3w pässword " + method + " "
			if err := c.SetPassword(ctx, dn, typed, method); err != nil {
				t.Fatalf("SetPassword(%s) error = %v", method, err)
			}
			p := testProfile()
			p.BindDN = dn
			user, err := Dial(ctx, p, typed)
			if err != nil {
				t.Fatalf("Dial(%s) with the new password error = %v", dn, err)
			}
			_ = user.Close()
			if _, err := Dial(ctx, p, "wrong"); !ldap.IsErrorWithCode(err, ldap.LDAPResultInvalidCredentials) {
				t.Errorf("Dial(%s) with a wrong password error = %v, want invalidCredentials", dn, err)
			}
		})
	}
	e, err := c.rawEntry(ctx, "uid=ssha,"+ou, []string{"userPassword"})
	if err != nil {
		t.Fatalf("rawEntry(userPassword) error = %v", err)
	}
	if !strings.HasPrefix(e.GetEqualFoldAttributeValue("userPassword"), "{SSHA}") {
		t.Error("userPassword after SetPassword(ssha) has no {SSHA} prefix")
	}
}

func TestMemberOfPosixGroup(t *testing.T) {
	c := dialAdmin(t)
	for _, nested := range []bool{false, true} {
		got, err := c.MemberOf(context.Background(), userDN(2), nested)
		if err != nil {
			t.Fatalf("MemberOf(%s, nested %v) error = %v", userDN(2), nested, err)
		}
		want := []Ref{{DN: groupDN("big")}, {DN: groupDN("posix")}}
		if diff := cmp.Diff(want, got.Refs, cmpSortRefs); diff != "" || got.Truncated {
			t.Errorf("MemberOf(%s, nested %v) truncated %v, mismatch (-want +got):\n%s", userDN(2), nested, got.Truncated, diff)
		}
	}
}

func TestMemberOfMissingEntry(t *testing.T) {
	_, err := dialAdmin(t).MemberOf(context.Background(), "uid=nobody,"+testPeople, false)
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchObject) {
		t.Errorf("MemberOf(missing) error = %v, want noSuchObject", err)
	}
}

func TestMemberOfEscapesUID(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	ou := writeOU(t, c, "memberuid")
	user := "uid=esc*," + ou
	if err := c.Add(ctx, user, personAttrs("esc*")); err != nil {
		t.Fatalf("Add(%s) error = %v", user, err)
	}
	posixGroup := func(cn, memberUID string) string {
		dn := "cn=" + cn + "," + ou
		if err := c.Add(ctx, dn, []TextAttribute{
			{Name: "objectClass", Values: []string{"posixGroup"}},
			{Name: "cn", Values: []string{cn}},
			{Name: "gidNumber", Values: []string{"7001"}},
			{Name: "memberUid", Values: []string{memberUID}},
		}); err != nil {
			t.Fatalf("Add(%s) error = %v", dn, err)
		}
		return dn
	}
	exact := posixGroup("exact", "esc*")
	posixGroup("wildcard", "escaped") // an unescaped (memberUid=esc*) matches it
	got, err := c.MemberOf(ctx, user, false)
	if err != nil {
		t.Fatalf("MemberOf(%s) error = %v", user, err)
	}
	if diff := cmp.Diff([]Ref{{DN: exact}}, got.Refs, cmpSortRefs); diff != "" {
		t.Errorf("MemberOf(%s) mismatch (-want +got):\n%s", user, diff)
	}
}

// testJPEG is a real JPEG of size x size gray pixels, as jpegPhoto takes.
func testJPEG(t *testing.T, size int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewGray(image.Rect(0, 0, size, size)), nil); err != nil {
		t.Fatalf("jpeg.Encode() error = %v", err)
	}
	return b.Bytes()
}

// testCertificate is a self-signed DER certificate with serial: OpenLDAP
// parses userCertificate values and matches them by issuer and serial.
func testCertificate(t *testing.T, serial int64) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ecdsa.GenerateKey() error = %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: "binary"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("x509.CreateCertificate() error = %v", err)
	}
	return der
}

func TestBinaryValues(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	b64 := base64.StdEncoding.EncodeToString
	photo, cert := b64(testJPEG(t, 2)), b64(testCertificate(t, 1))

	// A new entry with a photo and a certificate, both sent as base64.
	dn := "uid=bin," + writeOU(t, c, "binary")
	attrs := append(personAttrs("bin"),
		TextAttribute{Name: "jpegPhoto", Values: []string{photo}, Base64: true},
		TextAttribute{Name: "userCertificate;binary", Values: []string{cert}, Base64: true})
	if err := c.Add(ctx, dn, attrs); err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	if diff := cmp.Diff([]string{photo}, valuesOf(t, c, dn, "jpegPhoto")); diff != "" {
		t.Errorf("jpegPhoto after Add (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff([]string{cert}, valuesOf(t, c, dn, "userCertificate;binary")); diff != "" {
		t.Errorf("userCertificate;binary after Add (-want +got):\n%s", diff)
	}

	// Replacing the photo is a delete of the old value and an add of the new one.
	next := b64(testJPEG(t, 3))
	if err := c.Modify(ctx, dn, []Change{
		{Op: "delete", Attr: "jpegPhoto", Values: []string{photo}, Base64: true},
		{Op: "add", Attr: "jpegPhoto", Values: []string{next}, Base64: true},
	}); err != nil {
		t.Fatalf("Modify(replace jpegPhoto) error = %v", err)
	}
	if diff := cmp.Diff([]string{next}, valuesOf(t, c, dn, "jpegPhoto")); diff != "" {
		t.Errorf("jpegPhoto after Modify (-want +got):\n%s", diff)
	}
	if err := c.Modify(ctx, dn, []Change{{Op: "delete", Attr: "jpegPhoto", Values: []string{next}, Base64: true}}); err != nil {
		t.Fatalf("Modify(delete jpegPhoto) error = %v", err)
	}
	if got := valuesOf(t, c, dn, "jpegPhoto"); len(got) != 0 {
		t.Errorf("jpegPhoto after delete = %q, want none", got)
	}
	// A photo that is gone already: a stale delete, as with text values.
	err := c.Modify(ctx, dn, []Change{{Op: "delete", Attr: "jpegPhoto", Values: []string{next}, Base64: true}})
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchAttribute) {
		t.Errorf("Modify(delete a photo that is gone) error = %v, want noSuchAttribute", err)
	}
}

func TestAttributeOptions(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	dn := "uid=lang," + writeOU(t, c, "options")
	attrs := append(personAttrs("lang"), TextAttribute{Name: "cn;lang-de", Values: []string{"Person DE"}})
	if err := c.Add(ctx, dn, attrs); err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	// cn;lang-de changes on its own; cn keeps its value.
	if err := c.Modify(ctx, dn, []Change{
		{Op: "delete", Attr: "cn;lang-de", Values: []string{"Person DE"}},
		{Op: "add", Attr: "cn;lang-de", Values: []string{"Person Zwei"}},
	}); err != nil {
		t.Fatalf("Modify(cn;lang-de) error = %v", err)
	}
	if diff := cmp.Diff([]string{"Person Zwei"}, valuesOf(t, c, dn, "cn;lang-de")); diff != "" {
		t.Errorf("cn;lang-de after Modify (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff([]string{"Person lang"}, valuesOf(t, c, dn, "cn")); diff != "" {
		t.Errorf("cn after Modify (-want +got):\n%s", diff)
	}
	// cn;lang-de alone meets cn's MUST, as the client's validation assumes.
	if err := c.Modify(ctx, dn, []Change{{Op: "delete", Attr: "cn", Values: []string{"Person lang"}}}); err != nil {
		t.Errorf("Modify(delete every plain cn) error = %v", err)
	}
}

func TestBinaryDeletes(t *testing.T) {
	c := dialAdmin(t)
	ctx := context.Background()
	b64 := base64.StdEncoding.EncodeToString
	photos := []string{b64(testJPEG(t, 2)), b64(testJPEG(t, 3))}
	certs := []string{b64(testCertificate(t, 1)), b64(testCertificate(t, 2))}
	dn := "uid=del," + writeOU(t, c, "binarydeletes")
	attrs := append(personAttrs("del"),
		TextAttribute{Name: "jpegPhoto", Values: photos, Base64: true},
		TextAttribute{Name: "userCertificate;binary", Values: certs, Base64: true})
	if err := c.Add(ctx, dn, attrs); err != nil {
		t.Fatalf("Add() error = %v", err)
	}

	// jpegPhoto has no EQUALITY rule: the server refuses a plain delete of
	// one value, and Modify falls back to read + replace.
	deletePhoto := []Change{{Op: "delete", Attr: "jpegPhoto", Values: photos[:1], Base64: true}}
	if err := c.modify(ctx, dn, deletePhoto); !ldap.IsErrorWithCode(err, ldap.LDAPResultInappropriateMatching) {
		t.Errorf("plain delete of a jpegPhoto value error = %v, want inappropriateMatching", err)
	}
	if err := c.Modify(ctx, dn, deletePhoto); err != nil {
		t.Fatalf("Modify(delete a jpegPhoto value) error = %v", err)
	}
	if diff := cmp.Diff(photos[1:], valuesOf(t, c, dn, "jpegPhoto")); diff != "" {
		t.Errorf("jpegPhoto after delete (-want +got):\n%s", diff)
	}

	// Adding a photo next to one already there is refused the same way (the
	// server cannot check for a duplicate); Modify replaces instead.
	third := b64(testJPEG(t, 4))
	addPhoto := []Change{{Op: "add", Attr: "jpegPhoto", Values: []string{third}, Base64: true}}
	if err := c.modify(ctx, dn, addPhoto); !ldap.IsErrorWithCode(err, ldap.LDAPResultInappropriateMatching) {
		t.Errorf("plain add of a second jpegPhoto value error = %v, want inappropriateMatching", err)
	}
	if err := c.Modify(ctx, dn, addPhoto); err != nil {
		t.Fatalf("Modify(add a second jpegPhoto value) error = %v", err)
	}
	if diff := cmp.Diff([]string{photos[1], third}, valuesOf(t, c, dn, "jpegPhoto")); diff != "" {
		t.Errorf("jpegPhoto after add (-want +got):\n%s", diff)
	}
	// Changing the photo: delete the old one, add a new one, in one request.
	swap := []Change{
		{Op: "delete", Attr: "jpegPhoto", Values: []string{third}, Base64: true},
		{Op: "add", Attr: "jpegPhoto", Values: []string{photos[0]}, Base64: true},
	}
	if err := c.Modify(ctx, dn, swap); err != nil {
		t.Fatalf("Modify(swap a jpegPhoto value) error = %v", err)
	}
	if diff := cmp.Diff([]string{photos[1], photos[0]}, valuesOf(t, c, dn, "jpegPhoto")); diff != "" {
		t.Errorf("jpegPhoto after swap (-want +got):\n%s", diff)
	}

	// userCertificate matches by certificateExactMatch: the server takes a
	// plain delete, so Modify sends it as is and reads nothing first.
	deleteCert := func(i int) []Change {
		return []Change{{Op: "delete", Attr: "userCertificate;binary", Values: certs[i : i+1], Base64: true}}
	}
	if err := c.Modify(ctx, dn, deleteCert(0)); err != nil {
		t.Fatalf("Modify(delete a userCertificate;binary value) error = %v", err)
	}
	if diff := cmp.Diff(certs[1:], valuesOf(t, c, dn, "userCertificate;binary")); diff != "" {
		t.Errorf("userCertificate;binary after delete (-want +got):\n%s", diff)
	}
	if err := c.modify(ctx, dn, deleteCert(1)); err != nil {
		t.Errorf("plain delete of a userCertificate;binary value error = %v", err)
	}
	// A certificate that is gone already: the server's own stale delete.
	if err := c.Modify(ctx, dn, deleteCert(1)); !ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchAttribute) {
		t.Errorf("Modify(delete a certificate that is gone) error = %v, want noSuchAttribute", err)
	}
}
