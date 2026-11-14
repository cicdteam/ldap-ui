// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ad

import (
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func TestSID(t *testing.T) {
	tests := []struct {
		in      []byte
		want    string
		wantErr bool
	}{
		{in: []byte{1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0}, want: "S-1-1-0"},
		{in: []byte{1, 2, 0, 0, 0, 0, 0, 5, 0x20, 0, 0, 0, 0x20, 0x02, 0, 0}, want: "S-1-5-32-544"},
		{in: []byte{1, 2, 0, 0, 0, 0, 0, 5, 0x20, 0, 0, 0}, wantErr: true},
		{in: []byte{1}, wantErr: true},
	}
	for _, tc := range tests {
		got, err := SID(tc.in)
		if (err != nil) != tc.wantErr || got != tc.want {
			t.Errorf("SID(% x) = %q, %v, want %q, err %v", tc.in, got, err, tc.want, tc.wantErr)
		}
	}
}

func TestGUID(t *testing.T) {
	in := []byte{0xd4, 0xc3, 0xb2, 0xa1, 0xf6, 0xe5, 0x18, 0x07, 0x29, 0x2a, 0x3b, 0x4c, 0x5d, 0x6e, 0x7f, 0x80}
	if got, err := GUID(in); err != nil || got != "a1b2c3d4-e5f6-0718-292a-3b4c5d6e7f80" {
		t.Errorf("GUID(% x) = %q, %v, want a1b2c3d4-e5f6-0718-292a-3b4c5d6e7f80", in, got, err)
	}
	if _, err := GUID(in[:15]); err == nil {
		t.Error("GUID(15 bytes) error = nil, want error")
	}
}

func TestFileTime(t *testing.T) {
	tests := []struct {
		in        string
		want      time.Time
		wantNever bool
		wantErr   bool
	}{
		{in: "116444736000000000", want: time.Unix(0, 0).UTC()},
		{in: "132539328000000000", want: time.Date(2021, 1, 1, 0, 0, 0, 0, time.UTC)},
		{in: "0", wantNever: true},
		{in: "9223372036854775807", wantNever: true},
		{in: "abc", wantErr: true},
		{in: "1", wantErr: true},
	}
	for _, tc := range tests {
		got, never, err := FileTime(tc.in)
		if (err != nil) != tc.wantErr || never != tc.wantNever || !got.Equal(tc.want) {
			t.Errorf("FileTime(%q) = %v, %v, %v, want %v, %v, err %v", tc.in, got, never, err, tc.want, tc.wantNever, tc.wantErr)
		}
	}
}

func TestUACFlags(t *testing.T) {
	tests := []struct {
		in   uint32
		want []string
	}{
		{in: 0x200, want: []string{"NORMAL_ACCOUNT"}},
		{in: 0x10202, want: []string{"ACCOUNTDISABLE", "NORMAL_ACCOUNT", "DONT_EXPIRE_PASSWORD"}},
		{in: 0x4, want: []string{"0x4"}},
		{in: 0, want: nil},
	}
	for _, tc := range tests {
		if diff := cmp.Diff(tc.want, UACFlags(tc.in)); diff != "" {
			t.Errorf("UACFlags(%#x) mismatch (-want +got):\n%s", tc.in, diff)
		}
	}
}

func TestParseRange(t *testing.T) {
	tests := []struct {
		in        string
		wantAttr  string
		wantStart int
		wantEnd   int
		wantOK    bool
	}{
		{in: "member;range=0-1499", wantAttr: "member", wantStart: 0, wantEnd: 1499, wantOK: true},
		{in: "member;Range=1500-*", wantAttr: "member", wantStart: 1500, wantEnd: -1, wantOK: true},
		{in: "member", wantOK: false},
		{in: "member;range=x-1", wantOK: false},
		{in: "member;range=0--1", wantOK: false},
		{in: "member;range=1500-10", wantOK: false},
		{in: "userCertificate;binary", wantOK: false},
	}
	for _, tc := range tests {
		attr, start, end, ok := ParseRange(tc.in)
		if attr != tc.wantAttr || start != tc.wantStart || end != tc.wantEnd || ok != tc.wantOK {
			t.Errorf("ParseRange(%q) = %q, %d, %d, %v, want %q, %d, %d, %v", tc.in, attr, start, end, ok, tc.wantAttr, tc.wantStart, tc.wantEnd, tc.wantOK)
		}
	}
}

func TestDiagnosticReason(t *testing.T) {
	tests := map[string]string{
		"80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563": "invalid credentials",
		"80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 775, v4563": "account locked out",
		"data 999, v1": "",
		"":             "",
	}
	for in, want := range tests {
		if got := DiagnosticReason(in); got != want {
			t.Errorf("DiagnosticReason(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAttributeKinds(t *testing.T) {
	if !IsSIDAttribute("objectSid") || !IsGUIDAttribute("OBJECTGUID") || !IsFileTimeAttribute("pwdLastSet") {
		t.Error("attribute kind helpers failed on well-known AD attributes")
	}
	if IsSIDAttribute("cn") || IsGUIDAttribute("cn") || IsFileTimeAttribute("cn") {
		t.Error("attribute kind helpers matched cn")
	}
	if !IsActiveDirectory([]string{"1.2.840.113556.1.4.800", "1.2.840.113556.1.4.1670"}) || IsActiveDirectory(nil) {
		t.Error("IsActiveDirectory() wrong")
	}
}

func TestPasswordReason(t *testing.T) {
	tests := map[string]string{
		"0000052D: Constraint violation - check_password_restrictions: the password is too short": "password does not meet the policy",
		"0000052d: AtrErr: DSID-03191083, #1":                                                     "password does not meet the policy",
		"00000056: AtrErr: DSID-03190F80":                                                         "",
		"":                                                                                        "",
	}
	for in, want := range tests {
		if got := PasswordReason(in); got != want {
			t.Errorf("PasswordReason(%q) = %q, want %q", in, got, want)
		}
	}
}
