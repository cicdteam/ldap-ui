// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"bytes"
	"context"
	"crypto/sha1" //nolint:gosec // checks the {SSHA} scheme, which is SHA-1 by definition
	"encoding/base64"
	"errors"
	"net"
	"slices"
	"strings"
	"testing"

	ber "github.com/go-asn1-ber/asn1-ber"
	"github.com/go-ldap/ldap/v3"
	"github.com/google/go-cmp/cmp"

	"github.com/cicdteam/ldap-ui/internal/schema"
)

func TestIsSecret(t *testing.T) {
	empty := schema.Parse(nil, nil, nil)
	tests := []struct {
		attr string
		want bool
	}{
		{attr: "userPassword", want: true},
		{attr: "USERPASSWORD", want: true},
		{attr: "unicodePwd", want: true},
		{attr: "userPassword;binary", want: true},
		{attr: "2.5.4.35", want: true},
		// LDAPv2 spelled OIDs as "OID.2.5.4.35"; servers still take that in a DN.
		{attr: "OID.2.5.4.35", want: true},
		{attr: "oid.2.5.4.35;binary", want: true},
		{attr: "OID.2.5.4.3", want: false},
		{attr: "mail", want: false},
		{attr: "description", want: false},
	}
	for _, tc := range tests {
		if got := IsSecret(tc.attr, empty); got != tc.want {
			t.Errorf("IsSecret(%q) = %v, want %v", tc.attr, got, tc.want)
		}
	}
}

func TestSSHAHash(t *testing.T) {
	const typed = "pässword"
	h := sshaHash(typed)
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(h, "{SSHA}"))
	if !strings.HasPrefix(h, "{SSHA}") || err != nil || len(raw) != sha1.Size+8 {
		t.Fatalf("sshaHash() = %q (%v), want {SSHA} and base64 of a SHA-1 digest and an 8-byte salt", h, err)
	}
	digest, salt := raw[:sha1.Size], raw[sha1.Size:]
	want := sha1.Sum(append([]byte(typed), salt...)) //nolint:gosec // the {SSHA} scheme
	if !bytes.Equal(digest, want[:]) {
		t.Error("sshaHash() digest is not sha1(password || salt)")
	}
	if sshaHash(typed) == h {
		t.Error("sshaHash() gave the same value twice, want a new salt each time")
	}
}

func TestADPassword(t *testing.T) {
	tests := []struct {
		in   string
		want []byte
	}{
		{in: "Pa€", want: []byte{'"', 0, 'P', 0, 'a', 0, 0xAC, 0x20, '"', 0}},
		// Outside the BMP: a surrogate pair, each half little-endian.
		{in: "\U0001F600", want: []byte{'"', 0, 0x3D, 0xD8, 0x00, 0xDE, '"', 0}},
	}
	for _, tc := range tests {
		if got := []byte(adPassword(tc.in)); !bytes.Equal(got, tc.want) {
			t.Errorf("adPassword(%q) = % x, want % x", tc.in, got, tc.want)
		}
	}
}

func TestSetPasswordUnknownMethod(t *testing.T) {
	// Refused before any connection is used, so a Conn without one will do.
	err := (&Conn{}).SetPassword(context.Background(), "uid=x", "x", "plain")
	if !errors.Is(err, ErrInvalidRequest) {
		t.Errorf("SetPassword(plain) error = %v, want ErrInvalidRequest", err)
	}
}

func TestSetPasswordRefusesUnsafeRequests(t *testing.T) {
	// A closed Conn fails with net.ErrClosed once a request reaches the
	// connection, so ErrInvalidRequest shows SetPassword refused it before.
	tests := []struct {
		name     string
		info     Info
		password string
		method   string
	}{
		{name: "empty password, server", info: Info{Encrypted: true}, method: "server"},
		{name: "empty password, ssha", method: "ssha"},
		{name: "empty password, AD", info: Info{ActiveDirectory: true, Encrypted: true}},
		{name: "AD unencrypted", info: Info{ActiveDirectory: true}, password: "x"},
	}
	for _, tc := range tests {
		c := &Conn{closed: true, info: tc.info}
		err := c.SetPassword(context.Background(), "uid=x", tc.password, tc.method)
		if !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: SetPassword(%q, %q) error = %v, want ErrInvalidRequest", tc.name, tc.password, tc.method, err)
		}
	}
}

func TestSetPasswordADIgnoresMethod(t *testing.T) {
	// The web client sends no method on Active Directory, so the AD branch
	// comes before the method check and the request reaches the connection.
	for _, method := range []string{"", "plain"} {
		c := &Conn{closed: true, info: Info{ActiveDirectory: true, Encrypted: true}}
		err := c.SetPassword(context.Background(), "cn=x", "x", method)
		if !errors.Is(err, net.ErrClosed) {
			t.Errorf("SetPassword(method %q) on AD error = %v, want net.ErrClosed", method, err)
		}
	}
}

func TestRawValues(t *testing.T) {
	got, err := RawValues([]string{"/9j/", "AAEC"}, true)
	if err != nil || !slices.Equal(got, []string{"\xff\xd8\xff", "\x00\x01\x02"}) {
		t.Errorf("RawValues(base64) = %q, %v, want the decoded bytes", got, err)
	}
	text := []string{"Müller", "/9j/"}
	if got, err := RawValues(text, false); err != nil || !slices.Equal(got, text) {
		t.Errorf("RawValues(text) = %q, %v, want it as given", got, err)
	}
	if _, err := RawValues([]string{"AAEC", "not base64!"}, true); !errors.Is(err, ErrInvalidRequest) {
		t.Errorf("RawValues(bad base64) error = %v, want ErrInvalidRequest", err)
	}
}

func TestWritesRefuseBadBase64(t *testing.T) {
	// A closed Conn fails with net.ErrClosed once a request reaches the
	// connection, so ErrInvalidRequest shows the value was refused before.
	c := &Conn{closed: true}
	bad := []string{"not base64!"}
	err := c.Modify(context.Background(), "uid=x", []Change{{Op: "add", Attr: "jpegPhoto", Values: bad, Base64: true}})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Errorf("Modify(bad base64) error = %v, want ErrInvalidRequest", err)
	}
	err = c.Add(context.Background(), "uid=x", []TextAttribute{{Name: "jpegPhoto", Values: bad, Base64: true}})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Errorf("Add(bad base64) error = %v, want ErrInvalidRequest", err)
	}
}

func TestReplaceBinaryDeletes(t *testing.T) {
	const photo, other, next = "\xff\xd8\xff photo", "\xff\xd8\xff other", "\xff\xd8\xff next"
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	have := func(attr string) []string {
		if strings.EqualFold(attr, "jpegPhoto") {
			return []string{photo, other}
		}
		return nil
	}
	got, err := replaceBinaryChanges([]Change{
		{Op: "delete", Attr: "mail", Values: []string{"a@x"}},
		{Op: "delete", Attr: "jpegPhoto", Values: []string{b64(photo)}, Base64: true},
		{Op: "add", Attr: "JPEGPHOTO", Values: []string{b64(next)}, Base64: true},
		{Op: "add", Attr: "mail", Values: []string{"b@x"}},
	}, have)
	want := []Change{
		{Op: "delete", Attr: "mail", Values: []string{"a@x"}},
		{Op: "replace", Attr: "jpegPhoto", Values: []string{other, next}},
		{Op: "add", Attr: "mail", Values: []string{"b@x"}},
	}
	if diff := cmp.Diff(want, got); err != nil || diff != "" {
		t.Errorf("replaceBinaryChanges() error = %v, mismatch (-want +got):\n%s", err, diff)
	}
	// Deleting the last values leaves an empty replace: the attribute goes.
	got, err = replaceBinaryChanges([]Change{{Op: "delete", Attr: "jpegPhoto", Values: []string{b64(photo), b64(other)}, Base64: true}}, have)
	if err != nil || len(got) != 1 || got[0].Op != "replace" || len(got[0].Values) != 0 {
		t.Errorf("replaceBinaryChanges(every photo) = %+v, %v, want one empty replace", got, err)
	}
	// A value the entry no longer has is a stale delete.
	_, err = replaceBinaryChanges([]Change{{Op: "delete", Attr: "jpegPhoto", Values: []string{b64(next)}, Base64: true}}, have)
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchAttribute) {
		t.Errorf("replaceBinaryChanges(gone value) error = %v, want noSuchAttribute", err)
	}
	// A binary add alone (a second photo) becomes a replace too: adding a
	// value to an attribute without an EQUALITY rule fails like a delete.
	got, err = replaceBinaryChanges([]Change{{Op: "add", Attr: "jpegPhoto", Values: []string{b64(next)}, Base64: true}}, have)
	if err != nil || len(got) != 1 || got[0].Op != "replace" || len(got[0].Values) != 3 {
		t.Errorf("replaceBinaryChanges(binary add) = %+v, %v, want one replace with three values", got, err)
	}
	// Without a binary change nothing changes.
	same := []Change{{Op: "delete", Attr: "mail", Values: []string{"a@x"}}}
	if got, err := replaceBinaryChanges(same, have); err != nil || !cmp.Equal(got, same) {
		t.Errorf("replaceBinaryChanges(no binary change) = %+v, %v, want it unchanged", got, err)
	}
}

// modifyLine describes a modify request as the fake server got it, such as
// "modify: delete jpegPhoto, add mail".
func modifyLine(op *ber.Packet) string {
	changes := op.Children[1].Children
	parts := make([]string, len(changes))
	for i, ch := range changes {
		kind, _ := ch.Children[0].Value.(int64)
		name, _ := ch.Children[1].Children[0].Value.(string)
		parts[i] = [...]string{"add", "delete", "replace"}[kind] + " " + name
	}
	return "modify: " + strings.Join(parts, ", ")
}

// TestModifyFallback checks that Modify rewrites binary changes into a
// replace only when the server refused the plain modify as
// inappropriateMatching, an answer that means nothing was written.
func TestModifyFallback(t *testing.T) {
	const photo = "\xff\xd8\xff photo"
	binaryDelete := []Change{
		{Op: "delete", Attr: "jpegPhoto", Values: []string{base64.StdEncoding.EncodeToString([]byte(photo))}, Base64: true},
		{Op: "add", Attr: "mail", Values: []string{"a@x"}},
	}
	const plain = "modify: delete jpegPhoto, add mail"
	tests := []struct {
		name    string
		changes []Change
		// code answers the first modify; later ones succeed.
		code int64
		// want is the requests the server got, in order.
		want []string
		// wantCode is the LDAP result code Modify fails with, 0 for none.
		wantCode uint16
	}{
		{name: "no equality rule", changes: binaryDelete, code: ldap.LDAPResultInappropriateMatching, want: []string{plain, "search", "modify: replace jpegPhoto, add mail"}},
		{name: "written", changes: binaryDelete, code: ldap.LDAPResultSuccess, want: []string{plain}},
		{name: "other refusal", changes: binaryDelete, code: ldap.LDAPResultNoSuchAttribute, want: []string{plain}, wantCode: ldap.LDAPResultNoSuchAttribute},
		{name: "binary add", changes: []Change{{Op: "add", Attr: "jpegPhoto", Values: []string{base64.StdEncoding.EncodeToString([]byte("\xff\xd8\xff next"))}, Base64: true}}, code: ldap.LDAPResultInappropriateMatching, want: []string{"modify: add jpegPhoto", "search", "modify: replace jpegPhoto"}},
		{name: "text delete", changes: []Change{{Op: "delete", Attr: "mail", Values: []string{"a@x"}}}, code: ldap.LDAPResultInappropriateMatching, want: []string{"modify: delete mail"}, wantCode: ldap.LDAPResultInappropriateMatching},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// Each request is recorded before it is answered, so all of
			// them are in the channel once Modify returns.
			reqs := make(chan string, 10)
			url, _ := fakeServer(t, func(_ int32, conn net.Conn) {
				code := tc.code
				for {
					p, err := ber.ReadPacket(conn)
					if err != nil || len(p.Children) < 2 {
						return
					}
					id, _ := p.Children[0].Value.(int64)
					switch op := p.Children[1]; op.Tag {
					case ldap.ApplicationModifyRequest:
						reqs <- modifyLine(op)
						err = writeResult(conn, id, ldap.ApplicationModifyResponse, code)
						code = ldap.LDAPResultSuccess
					case ldap.ApplicationSearchRequest:
						reqs <- "search"
						err = errors.Join(writeEntry(conn, id, "uid=a", attr("jpegPhoto", photo)),
							writeResult(conn, id, ldap.ApplicationSearchResultDone, ldap.LDAPResultSuccess))
					default:
						return
					}
					if err != nil {
						return
					}
				}
			})
			err := fakeConn(t, url).Modify(context.Background(), "uid=a", tc.changes)
			if tc.wantCode == 0 && err != nil || tc.wantCode != 0 && !ldap.IsErrorWithCode(err, tc.wantCode) {
				t.Errorf("Modify() error = %v, want result code %d", err, tc.wantCode)
			}
			var got []string
			for len(reqs) > 0 {
				got = append(got, <-reqs)
			}
			if diff := cmp.Diff(tc.want, got); diff != "" {
				t.Errorf("requests the server got (-want +got):\n%s", diff)
			}
		})
	}
}
