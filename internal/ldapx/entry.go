// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

// Package ldapx is ldapui's LDAP client. It wraps go-ldap with paging,
// reconnects, Active Directory decoding and group membership queries.
package ldapx

import (
	"bytes"
	"encoding/base64"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-ldap/ldap/v3"

	"github.com/cicdteam/ldap-ui/internal/ad"
	"github.com/cicdteam/ldap-ui/internal/schema"
)

// Value is one attribute value.
type Value struct {
	// Text is the value as UTF-8, or standard base64 when Base64 is set.
	Text   string `json:"text"`
	Base64 bool   `json:"base64,omitempty"`
	// Display is a human-readable rendering (a SID, a date, flag names)
	// when Text is not readable on its own.
	Display string `json:"display,omitempty"`
}

// Attribute is one attribute of an entry. Secret attributes carry no
// values; Masked counts the values that were withheld.
type Attribute struct {
	Name   string  `json:"name"`
	Values []Value `json:"values"`
	Masked int     `json:"masked,omitempty"`
}

// Entry is a directory entry ready for the UI.
type Entry struct {
	DN         string      `json:"dn"`
	Attributes []Attribute `json:"attributes"`
}

// secretAttributes never leave the server. Keys are lower-cased names plus
// the well-known OIDs, because a client may ask for "2.5.4.35" and some
// servers return the attribute under that OID.
var secretAttributes = map[string]bool{
	"userpassword": true, "unicodepwd": true, "sambantpassword": true, "sambalmpassword": true,
	"authpassword": true, "supplementalcredentials": true, "dbcspwd": true, "ntpwdhistory": true,
	"lmpwdhistory": true,
	// Password histories, Kerberos keys, LAPS and gMSA passwords, BitLocker
	// and TPM recovery secrets, and PKCS #12 bundles with private keys.
	"pwdhistory": true, "sambapasswordhistory": true, "krbprincipalkey": true, "ipanthash": true,
	"ms-mcs-admpwd": true, "mslaps-password": true, "mslaps-encryptedpassword": true,
	"mslaps-encryptedpasswordhistory": true, "mslaps-encrypteddsrmpassword": true,
	"mslaps-encrypteddsrmpasswordhistory": true, "msds-managedpassword": true,
	"msfve-recoverypassword": true, "mstpm-ownerinformation": true, "userpkcs12": true,

	"2.5.4.35":                true, // userPassword
	"1.3.6.1.4.1.7165.2.1.24": true, // sambaLMPassword
	"1.3.6.1.4.1.7165.2.1.25": true, // sambaNTPassword
	"1.3.6.1.4.1.4203.1.3.4":  true, // authPassword
	"1.2.840.113556.1.4.90":   true, // unicodePwd
	"1.2.840.113556.1.4.55":   true, // dBCSPwd
	"1.2.840.113556.1.4.94":   true, // ntPwdHistory
	"1.2.840.113556.1.4.160":  true, // lmPwdHistory
	"1.2.840.113556.1.4.125":  true, // supplementalCredentials
}

// isSecret reports whether the attribute must be masked, by its returned
// name (base is name without options, lower-cased) or by what the schema
// resolves it to, which catches OIDs and aliases of secret types.
func isSecret(name, base string, s *schema.Schema) bool {
	if secretAttributes[base] {
		return true
	}
	at, ok := s.AttributeType(name)
	if !ok {
		return false
	}
	if secretAttributes[strings.ToLower(at.OID)] {
		return true
	}
	for _, n := range at.Names {
		if secretAttributes[strings.ToLower(n)] {
			return true
		}
	}
	return false
}

// convertEntry and convertAttribute make empty lists non-nil, so the UI gets
// [] rather than null.
func convertEntry(e *ldap.Entry, s *schema.Schema, isAD bool) Entry {
	out := Entry{DN: e.DN, Attributes: make([]Attribute, 0, len(e.Attributes))}
	for _, a := range e.Attributes {
		out.Attributes = append(out.Attributes, convertAttribute(a.Name, a.ByteValues, s, isAD))
	}
	return out
}

func convertAttribute(name string, raw [][]byte, s *schema.Schema, isAD bool) Attribute {
	base, _, _ := strings.Cut(name, ";")
	base = strings.ToLower(base)
	if isSecret(name, base, s) {
		return Attribute{Name: name, Values: []Value{}, Masked: len(raw)}
	}
	binary := s.IsBinary(name)
	timeSyntax := s.Syntax(name) == schema.SyntaxGeneralizedTime
	a := Attribute{Name: name, Values: make([]Value, 0, len(raw))}
	for _, b := range raw {
		a.Values = append(a.Values, convertValue(base, b, binary, timeSyntax, isAD))
	}
	return a
}

func convertValue(base string, b []byte, binary, timeSyntax, isAD bool) Value {
	if isAD {
		if v, ok := convertADValue(base, b); ok {
			return v
		}
	}
	if binary || !isText(b) {
		return Value{Text: base64.StdEncoding.EncodeToString(b), Base64: true}
	}
	v := Value{Text: string(b)}
	if timeSyntax {
		if t, err := time.Parse("20060102150405Z0700", v.Text); err == nil {
			v.Display = t.UTC().Format(time.RFC3339)
		}
	}
	return v
}

func convertADValue(base string, b []byte) (Value, bool) {
	switch {
	case ad.IsSIDAttribute(base):
		if sid, err := ad.SID(b); err == nil {
			return Value{Text: base64.StdEncoding.EncodeToString(b), Base64: true, Display: sid}, true
		}
	case ad.IsGUIDAttribute(base):
		if g, err := ad.GUID(b); err == nil {
			return Value{Text: base64.StdEncoding.EncodeToString(b), Base64: true, Display: g}, true
		}
	case ad.IsFileTimeAttribute(base):
		if t, never, err := ad.FileTime(string(b)); err == nil {
			switch {
			// AD sets pwdLastSet to 0 to force a password change.
			case never && base == "pwdlastset" && string(b) == "0":
				return Value{Text: string(b), Display: "must change at next logon"}, true
			case never:
				return Value{Text: string(b), Display: "never"}, true
			}
			return Value{Text: string(b), Display: t.Format(time.RFC3339)}, true
		}
	case base == "useraccountcontrol":
		if n, err := strconv.ParseUint(string(b), 10, 32); err == nil {
			return Value{Text: string(b), Display: strings.Join(ad.UACFlags(uint32(n)), " ")}, true
		}
	}
	return Value{}, false
}

// isText reports whether b is UTF-8 without control characters other than
// tab, newline and carriage return.
func isText(b []byte) bool {
	return utf8.Valid(b) && !bytes.ContainsFunc(b, func(r rune) bool {
		return r < 0x20 && r != '\t' && r != '\n' && r != '\r'
	})
}
