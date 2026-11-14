// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"context"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // {SSHA} is SHA-1 by definition; Password Modify is the default
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/go-ldap/ldap/v3"

	"github.com/cicdteam/ldap-ui/internal/schema"
)

// MaxValue bounds one attribute value, in bytes once decoded: a photo or a
// certificate fits, and a write request stays a few MiB.
const MaxValue = 1 << 20

// Change is one operation of an LDAP modify on one attribute. Changing a
// value is a delete of the old value plus an add of the new one, so the
// server rejects the request when someone else changed it meanwhile.
type Change struct {
	// Op is "add", "delete" or "replace". The UI sends only add and delete
	// (changes/apply refuses any other op); replace comes from Modify itself,
	// when it rewrites binary changes with replaceBinaryChanges.
	Op     string   `json:"op"`
	Attr   string   `json:"attr"`
	Values []string `json:"values"`
	// Base64 says every value is standard base64: a binary value.
	Base64 bool `json:"base64,omitempty"`
}

// RawValues is values as the directory stores them: decoded from standard
// base64 when b64 is set, else as given. A value that does not decode is
// ErrInvalidRequest; the error never holds the value.
func RawValues(values []string, b64 bool) ([]string, error) {
	if !b64 {
		return values, nil
	}
	raw := make([]string, len(values))
	for i, v := range values {
		b, err := base64.StdEncoding.DecodeString(v)
		if err != nil {
			return nil, fmt.Errorf("%w: value %d is not base64", ErrInvalidRequest, i+1)
		}
		raw[i] = string(b)
	}
	return raw, nil
}

// IsSecret reports whether attr is a secret attribute (a password or key)
// by its name, its options stripped, or what the schema resolves it to. An
// LDAPv2 "OID." prefix, which servers still take in a DN, is ignored.
func IsSecret(attr string, s *schema.Schema) bool {
	if len(attr) > 4 && strings.EqualFold(attr[:4], "oid.") {
		attr = attr[4:]
	}
	base, _, _ := strings.Cut(attr, ";")
	return isSecret(attr, strings.ToLower(base), s)
}

// Modify applies changes to dn as one LDAP modify request, which the server
// applies atomically. Writes are never retried: when the connection was
// lost the caller gets a network error and decides. Only an
// inappropriateMatching refusal of a binary change, which writes nothing,
// gets a second request: the attribute has no EQUALITY rule (jpegPhoto), so
// the server can neither find a value to delete nor check an added one for a
// duplicate, and the changes go once more rewritten by replaceBinaryChanges.
func (c *Conn) Modify(ctx context.Context, dn string, changes []Change) error {
	err := c.modify(ctx, dn, changes)
	if !ldap.IsErrorWithCode(err, ldap.LDAPResultInappropriateMatching) || !slices.ContainsFunc(changes, isBinaryChange) {
		return err
	}
	var attrs []string
	for _, ch := range changes {
		if isBinaryChange(ch) {
			attrs = append(attrs, ch.Attr)
		}
	}
	e, err := c.rawEntry(ctx, dn, attrs)
	if err != nil {
		return err
	}
	if changes, err = replaceBinaryChanges(changes, e.GetEqualFoldAttributeValues); err != nil {
		return err
	}
	return c.modify(ctx, dn, changes)
}

// modify sends changes to dn as one modify request, as they are.
func (c *Conn) modify(ctx context.Context, dn string, changes []Change) error {
	req := ldap.NewModifyRequest(dn, nil)
	for _, ch := range changes {
		vals, err := RawValues(ch.Values, ch.Base64)
		if err != nil {
			return err
		}
		switch ch.Op {
		case "add":
			req.Add(ch.Attr, vals)
		case "delete":
			req.Delete(ch.Attr, vals)
		case "replace":
			req.Replace(ch.Attr, vals)
		default:
			return fmt.Errorf("%w: unknown operation %q", ErrInvalidRequest, ch.Op)
		}
	}
	lc, err := c.current(ctx)
	if err != nil {
		return err
	}
	// go-ldap's Modify takes no context; the connection's request timeout
	// (the profile's search timeout) bounds it.
	return networkError(lc.Modify(req))
}

// isBinaryChange reports whether ch adds or deletes binary (base64) values.
func isBinaryChange(ch Change) bool { return ch.Base64 && (ch.Op == "add" || ch.Op == "delete") }

// replaceBinaryChanges turns the changes of every attribute with a binary
// add or delete into one replace with the values the attribute will hold;
// have gives an attribute's raw values now. OpenLDAP can neither delete one
// value of an attribute without an EQUALITY rule, such as jpegPhoto, nor add
// one next to values already there, but it replaces them all. A value to delete that have lacks fails as noSuchAttribute, the
// answer to a stale delete. Other changes stay as they are, in order.
// ponytail: read, then replace: a value someone adds in between is lost (only
// after the server refused the plain delete); an LDAP assertion control on
// the replace would close that window.
func replaceBinaryChanges(changes []Change, have func(attr string) []string) ([]Change, error) {
	out := make([]Change, 0, len(changes))
	var done []string
	for _, ch := range changes {
		same := func(c Change) bool { return strings.EqualFold(c.Attr, ch.Attr) }
		if !slices.ContainsFunc(changes, func(c Change) bool { return same(c) && isBinaryChange(c) }) {
			out = append(out, ch)
			continue
		}
		if slices.ContainsFunc(done, func(a string) bool { return strings.EqualFold(a, ch.Attr) }) {
			continue
		}
		done = append(done, ch.Attr)
		vals := slices.Clone(have(ch.Attr))
		for _, c := range slices.DeleteFunc(slices.Clone(changes), func(c Change) bool { return !same(c) }) {
			raw, err := RawValues(c.Values, c.Base64)
			if err != nil {
				return nil, err
			}
			for _, v := range raw {
				switch c.Op {
				case "add":
					vals = append(vals, v)
				case "delete":
					i := slices.Index(vals, v)
					if i < 0 {
						return nil, ldap.NewError(ldap.LDAPResultNoSuchAttribute, fmt.Errorf("modify/delete: %s: no such value", ch.Attr))
					}
					vals = slices.Delete(vals, i, i+1)
				default:
					return nil, fmt.Errorf("%w: unknown operation %q", ErrInvalidRequest, c.Op)
				}
			}
		}
		out = append(out, Change{Op: "replace", Attr: ch.Attr, Values: vals})
	}
	return out, nil
}

// TextAttribute is one attribute of a new entry: its values as text, or as
// standard base64 when Base64 is set.
type TextAttribute struct {
	Name   string   `json:"name"`
	Values []string `json:"values"`
	Base64 bool     `json:"base64,omitempty"`
}

// Add creates dn with attrs as one LDAP add. Like Modify it is never
// retried.
func (c *Conn) Add(ctx context.Context, dn string, attrs []TextAttribute) error {
	req := ldap.NewAddRequest(dn, nil)
	for _, a := range attrs {
		vals, err := RawValues(a.Values, a.Base64)
		if err != nil {
			return err
		}
		req.Attribute(a.Name, vals)
	}
	lc, err := c.current(ctx)
	if err != nil {
		return err
	}
	return networkError(lc.Add(req))
}

// Delete removes dn. The server refuses an entry that has children. It is
// never retried.
func (c *Conn) Delete(ctx context.Context, dn string) error {
	lc, err := c.current(ctx)
	if err != nil {
		return err
	}
	return networkError(lc.Del(ldap.NewDelRequest(dn, nil)))
}

// Rename moves dn to newRDN under newParent ("" keeps the parent).
// deleteOld drops the old RDN value from the entry. It is never retried.
func (c *Conn) Rename(ctx context.Context, dn, newRDN, newParent string, deleteOld bool) error {
	lc, err := c.current(ctx)
	if err != nil {
		return err
	}
	return networkError(lc.ModifyDN(ldap.NewModifyDNRequest(dn, newRDN, deleteOld, newParent)))
}

// SetPassword sets dn's password: on Active Directory it replaces unicodePwd
// with the quoted password in UTF-16LE and ignores method; otherwise method
// "server" runs the Password Modify extended operation, which hashes by the
// server's policy, and "ssha" replaces userPassword with a salted SHA-1
// hash. An empty password, and any password to Active Directory over an
// unencrypted connection, is refused with ErrInvalidRequest before anything
// is sent. Writes are never retried.
func (c *Conn) SetPassword(ctx context.Context, dn, password, method string) error {
	var mod *ldap.ModifyRequest
	switch {
	case password == "":
		// Password Modify without newPassword makes the server pick one
		// that nobody gets to see.
		return fmt.Errorf("%w: empty password", ErrInvalidRequest)
	case c.info.ActiveDirectory && !c.info.Encrypted:
		return fmt.Errorf("%w: Active Directory accepts passwords only over an encrypted connection", ErrInvalidRequest)
	case c.info.ActiveDirectory:
		mod = ldap.NewModifyRequest(dn, nil)
		mod.Replace("unicodePwd", []string{adPassword(password)})
	case method == "ssha":
		mod = ldap.NewModifyRequest(dn, nil)
		mod.Replace("userPassword", []string{sshaHash(password)})
	case method != "server":
		return fmt.Errorf("%w: unknown password method %q", ErrInvalidRequest, method)
	}
	lc, err := c.current(ctx)
	if err != nil {
		return err
	}
	if mod != nil {
		return networkError(lc.Modify(mod))
	}
	// newPassword is never empty, so the server does not generate one.
	_, err = lc.PasswordModify(ldap.NewPasswordModifyRequest(dn, "", password))
	return networkError(err)
}

// sshaHash is password as an {SSHA} userPassword value: base64 of
// sha1(password || salt) || salt, with a fresh 8-byte salt.
func sshaHash(password string) string {
	salt := make([]byte, 8)
	_, _ = rand.Read(salt)                             // never fails since Go 1.24
	sum := sha1.Sum(append([]byte(password), salt...)) //nolint:gosec // {SSHA} is SHA-1 by definition
	return "{SSHA}" + base64.StdEncoding.EncodeToString(append(sum[:], salt...))
}

// adPassword is password as Active Directory's unicodePwd takes it: in
// double quotes, UTF-16LE.
func adPassword(password string) string {
	units := utf16.Encode([]rune(`"` + password + `"`))
	b := make([]byte, 0, 2*len(units))
	for _, u := range units {
		b = binary.LittleEndian.AppendUint16(b, u)
	}
	return string(b)
}
