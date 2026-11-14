// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/cicdteam/ldap-ui/internal/schema"
)

func TestConvertAttribute(t *testing.T) {
	s := schema.Parse([]string{
		"( 0.9.2342.19200300.100.1.60 NAME 'jpegPhoto' SYNTAX 1.3.6.1.4.1.1466.115.121.1.28 )",
		"( 2.5.18.1 NAME 'createTimestamp' SYNTAX 1.3.6.1.4.1.1466.115.121.1.24 SINGLE-VALUE )",
	}, nil, nil)
	sid := []byte{1, 2, 0, 0, 0, 0, 0, 5, 0x20, 0, 0, 0, 0x20, 0x02, 0, 0}
	guid := []byte{0xd4, 0xc3, 0xb2, 0xa1, 0xf6, 0xe5, 0x18, 0x07, 0x29, 0x2a, 0x3b, 0x4c, 0x5d, 0x6e, 0x7f, 0x80}
	samba := schema.Parse([]string{
		"( 1.3.6.1.4.1.7165.2.1.25 NAME 'sambaNTPassword' EQUALITY caseIgnoreIA5Match SYNTAX 1.3.6.1.4.1.1466.115.121.1.26{32} SINGLE-VALUE )",
	}, nil, nil)
	tests := []struct {
		name string
		attr string
		raw  [][]byte
		isAD bool
		s    *schema.Schema // nil means the shared s above
		want Attribute
	}{
		{
			name: "secret is masked", attr: "userPassword", raw: [][]byte{[]byte("{SSHA}abc"), []byte("{SSHA}def")},
			want: Attribute{Name: "userPassword", Values: []Value{}, Masked: 2},
		},
		{
			name: "secret by well-known OID without schema", attr: "2.5.4.35", raw: [][]byte{[]byte("{SSHA}abc")},
			s:    schema.Parse(nil, nil, nil),
			want: Attribute{Name: "2.5.4.35", Values: []Value{}, Masked: 1},
		},
		{
			name: "secret by OID from schema", attr: "1.3.6.1.4.1.7165.2.1.25", raw: [][]byte{[]byte("0123456789ABCDEF")},
			s:    samba,
			want: Attribute{Name: "1.3.6.1.4.1.7165.2.1.25", Values: []Value{}, Masked: 1},
		},
		{
			name: "AD LAPS password", attr: "ms-Mcs-AdmPwd", raw: [][]byte{[]byte("hunter2")}, isAD: true,
			want: Attribute{Name: "ms-Mcs-AdmPwd", Values: []Value{}, Masked: 1},
		},
		{
			name: "AD gMSA password", attr: "msDS-ManagedPassword", raw: [][]byte{{1, 0, 0, 0}}, isAD: true,
			want: Attribute{Name: "msDS-ManagedPassword", Values: []Value{}, Masked: 1},
		},
		{
			name: "OpenLDAP ppolicy history", attr: "pwdHistory", raw: [][]byte{[]byte("20261110120000Z#1.3.6.1.4.1.1466.115.121.1.40#6#{SSHA}abc")},
			want: Attribute{Name: "pwdHistory", Values: []Value{}, Masked: 1},
		},
		{
			name: "samba LM hash by OID without schema", attr: "1.3.6.1.4.1.7165.2.1.24", raw: [][]byte{[]byte("0123456789ABCDEF")},
			s:    schema.Parse(nil, nil, nil),
			want: Attribute{Name: "1.3.6.1.4.1.7165.2.1.24", Values: []Value{}, Masked: 1},
		},
		{
			name: "samba NT hash by OID without schema", attr: "1.3.6.1.4.1.7165.2.1.25", raw: [][]byte{[]byte("0123456789ABCDEF")},
			s:    schema.Parse(nil, nil, nil),
			want: Attribute{Name: "1.3.6.1.4.1.7165.2.1.25", Values: []Value{}, Masked: 1},
		},
		{
			name: "plain text", attr: "cn", raw: [][]byte{[]byte("Ivanov")},
			want: Attribute{Name: "cn", Values: []Value{{Text: "Ivanov"}}},
		},
		{
			name: "AD sid", attr: "objectSid", raw: [][]byte{sid}, isAD: true,
			want: Attribute{Name: "objectSid", Values: []Value{{Text: "AQIAAAAAAAUgAAAAIAIAAA==", Base64: true, Display: "S-1-5-32-544"}}},
		},
		{
			name: "sid bytes outside AD are base64", attr: "objectSid", raw: [][]byte{sid},
			want: Attribute{Name: "objectSid", Values: []Value{{Text: "AQIAAAAAAAUgAAAAIAIAAA==", Base64: true}}},
		},
		{
			name: "AD guid", attr: "objectGUID", raw: [][]byte{guid}, isAD: true,
			want: Attribute{Name: "objectGUID", Values: []Value{{Text: "1MOyofblGAcpKjtMXW5/gA==", Base64: true, Display: "a1b2c3d4-e5f6-0718-292a-3b4c5d6e7f80"}}},
		},
		{
			name: "AD filetime", attr: "pwdLastSet", raw: [][]byte{[]byte("132539328000000000"), []byte("0")}, isAD: true,
			want: Attribute{Name: "pwdLastSet", Values: []Value{
				{Text: "132539328000000000", Display: "2021-01-01T00:00:00Z"},
				{Text: "0", Display: "must change at next logon"},
			}},
		},
		{
			name: "AD filetime not set", attr: "accountExpires", raw: [][]byte{[]byte("0"), []byte("9223372036854775807")}, isAD: true,
			want: Attribute{Name: "accountExpires", Values: []Value{
				{Text: "0", Display: "never"},
				{Text: "9223372036854775807", Display: "never"},
			}},
		},
		{
			name: "AD userAccountControl", attr: "userAccountControl", raw: [][]byte{[]byte("66050")}, isAD: true,
			want: Attribute{Name: "userAccountControl", Values: []Value{{Text: "66050", Display: "ACCOUNTDISABLE NORMAL_ACCOUNT DONT_EXPIRE_PASSWORD"}}},
		},
		{
			name: "binary syntax", attr: "jpegPhoto", raw: [][]byte{[]byte("JFIF")},
			want: Attribute{Name: "jpegPhoto", Values: []Value{{Text: "SkZJRg==", Base64: true}}},
		},
		{
			name: "invalid utf8", attr: "cn", raw: [][]byte{{0xff, 0xfe}},
			want: Attribute{Name: "cn", Values: []Value{{Text: "//4=", Base64: true}}},
		},
		{
			name: "control bytes", attr: "description", raw: [][]byte{{'a', 0x00, 'b'}},
			want: Attribute{Name: "description", Values: []Value{{Text: "YQBi", Base64: true}}},
		},
		{
			name: "multi-line text stays text", attr: "description", raw: [][]byte{[]byte("line1\nline2\ttab")},
			want: Attribute{Name: "description", Values: []Value{{Text: "line1\nline2\ttab"}}},
		},
		{
			name: "generalized time", attr: "createTimestamp", raw: [][]byte{[]byte("20261110120000Z"), []byte("20261110120000.0Z")},
			want: Attribute{Name: "createTimestamp", Values: []Value{
				{Text: "20261110120000Z", Display: "2026-11-10T12:00:00Z"},
				{Text: "20261110120000.0Z", Display: "2026-11-10T12:00:00Z"},
			}},
		},
	}
	for _, tc := range tests {
		ts := s
		if tc.s != nil {
			ts = tc.s
		}
		got := convertAttribute(tc.attr, tc.raw, ts, tc.isAD)
		if diff := cmp.Diff(tc.want, got); diff != "" {
			t.Errorf("%s: convertAttribute(%q) mismatch (-want +got):\n%s", tc.name, tc.attr, diff)
		}
	}
}
