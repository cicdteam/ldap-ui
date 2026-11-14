// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

// Package ad decodes Active Directory attribute values and bind errors.
package ad

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// capActiveDirectory is LDAP_CAP_ACTIVE_DIRECTORY_OID from supportedCapabilities.
const capActiveDirectory = "1.2.840.113556.1.4.800"

// IsActiveDirectory reports whether a root DSE's supportedCapabilities
// identify an Active Directory domain controller.
func IsActiveDirectory(capabilities []string) bool {
	return slices.Contains(capabilities, capActiveDirectory)
}

// SID formats a binary security identifier as S-R-A-S1-S2-...
func SID(b []byte) (string, error) {
	if len(b) < 8 {
		return "", errors.New("sid: too short")
	}
	n := int(b[1])
	if len(b) != 8+4*n {
		return "", fmt.Errorf("sid: %d bytes do not hold %d sub-authorities", len(b), n)
	}
	var authority uint64
	for _, x := range b[2:8] {
		authority = authority<<8 | uint64(x)
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "S-%d-%d", b[0], authority)
	for i := range n {
		fmt.Fprintf(&sb, "-%d", binary.LittleEndian.Uint32(b[8+4*i:]))
	}
	return sb.String(), nil
}

// GUID formats a binary objectGUID. The first three groups are stored
// little-endian, the rest in byte order.
func GUID(b []byte) (string, error) {
	if len(b) != 16 {
		return "", fmt.Errorf("guid: want 16 bytes, got %d", len(b))
	}
	return fmt.Sprintf("%08x-%04x-%04x-%x-%x",
		binary.LittleEndian.Uint32(b[0:4]), binary.LittleEndian.Uint16(b[4:6]), binary.LittleEndian.Uint16(b[6:8]),
		b[8:10], b[10:16]), nil
}

// fileTimeUnixEpoch is 1970-01-01 in FILETIME units (100 ns since 1601).
const fileTimeUnixEpoch = 116444736000000000

// FileTime parses an AD FILETIME written as a decimal string. never is true
// for 0 and math.MaxInt64, which AD uses for "not set" and "never expires".
func FileTime(s string) (t time.Time, never bool, err error) {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("filetime: %w", err)
	}
	if v == 0 || v == math.MaxInt64 {
		return time.Time{}, true, nil
	}
	d := v - fileTimeUnixEpoch
	if d > math.MaxInt64/100 || d < math.MinInt64/100 {
		return time.Time{}, false, fmt.Errorf("filetime: %d is out of range", v)
	}
	return time.Unix(0, d*100).UTC(), false, nil
}

var uacFlags = []struct {
	bit  uint32
	name string
}{
	{0x1, "SCRIPT"},
	{0x2, "ACCOUNTDISABLE"},
	{0x8, "HOMEDIR_REQUIRED"},
	{0x10, "LOCKOUT"},
	{0x20, "PASSWD_NOTREQD"},
	{0x40, "PASSWD_CANT_CHANGE"},
	{0x80, "ENCRYPTED_TEXT_PWD_ALLOWED"},
	{0x100, "TEMP_DUPLICATE_ACCOUNT"},
	{0x200, "NORMAL_ACCOUNT"},
	{0x800, "INTERDOMAIN_TRUST_ACCOUNT"},
	{0x1000, "WORKSTATION_TRUST_ACCOUNT"},
	{0x2000, "SERVER_TRUST_ACCOUNT"},
	{0x10000, "DONT_EXPIRE_PASSWORD"},
	{0x20000, "MNS_LOGON_ACCOUNT"},
	{0x40000, "SMARTCARD_REQUIRED"},
	{0x80000, "TRUSTED_FOR_DELEGATION"},
	{0x100000, "NOT_DELEGATED"},
	{0x200000, "USE_DES_KEY_ONLY"},
	{0x400000, "DONT_REQ_PREAUTH"},
	{0x800000, "PASSWORD_EXPIRED"},
	{0x1000000, "TRUSTED_TO_AUTH_FOR_DELEGATION"},
	{0x4000000, "PARTIAL_SECRETS_ACCOUNT"},
}

// UACFlags names the bits set in a userAccountControl value. Unknown bits
// are rendered as hex.
func UACFlags(v uint32) []string {
	var out []string
	for _, f := range uacFlags {
		if v&f.bit != 0 {
			out = append(out, f.name)
			v &^= f.bit
		}
	}
	for bit := uint32(1); v != 0; bit <<= 1 {
		if v&bit != 0 {
			out = append(out, fmt.Sprintf("0x%X", bit))
			v &^= bit
		}
	}
	return out
}

// ParseRange parses a ranged attribute description such as
// "member;range=0-1499". end is -1 when the server marks the last chunk
// with "*".
func ParseRange(desc string) (attr string, start, end int, ok bool) {
	attr, opts, found := strings.Cut(desc, ";")
	if !found {
		return "", 0, 0, false
	}
	for _, o := range strings.Split(opts, ";") {
		r, isRange := strings.CutPrefix(strings.ToLower(o), "range=")
		if !isRange {
			continue
		}
		lo, hi, found := strings.Cut(r, "-")
		if !found {
			return "", 0, 0, false
		}
		s, err := strconv.Atoi(lo)
		if err != nil {
			return "", 0, 0, false
		}
		if hi == "*" {
			return attr, s, -1, true
		}
		e, err := strconv.Atoi(hi)
		// lo cannot hold "-", so s >= 0; e < s also rejects a negative end
		// that would masquerade as the "*" marker.
		if err != nil || e < s {
			return "", 0, 0, false
		}
		return attr, s, e, true
	}
	return "", 0, 0, false
}

var diagnosticData = regexp.MustCompile(`\bdata ([0-9a-fA-F]+)\b`)

var bindReasons = map[string]string{
	"525": "user not found",
	"52e": "invalid credentials",
	"530": "logon not permitted at this time",
	"531": "logon not permitted from this workstation",
	"532": "password expired",
	"533": "account disabled",
	"701": "account expired",
	"773": "user must reset password",
	"775": "account locked out",
}

// DiagnosticReason explains the "data XXX" sub-code that AD puts in the
// diagnostic message of a failed bind. It returns "" when there is none.
func DiagnosticReason(msg string) string {
	m := diagnosticData.FindStringSubmatch(msg)
	if m == nil {
		return ""
	}
	return bindReasons[strings.ToLower(m[1])]
}

var (
	sidAttributes      = map[string]bool{"objectsid": true, "sidhistory": true, "securityidentifier": true, "tokengroups": true}
	guidAttributes     = map[string]bool{"objectguid": true, "schemaidguid": true, "attributesecurityguid": true}
	fileTimeAttributes = map[string]bool{
		"lastlogon": true, "lastlogontimestamp": true, "lastlogoff": true, "pwdlastset": true,
		"accountexpires": true, "badpasswordtime": true, "lockouttime": true,
	}
)

// IsSIDAttribute reports whether an attribute holds binary SIDs.
func IsSIDAttribute(name string) bool { return sidAttributes[strings.ToLower(name)] }

// IsGUIDAttribute reports whether an attribute holds binary GUIDs.
func IsGUIDAttribute(name string) bool { return guidAttributes[strings.ToLower(name)] }

// IsFileTimeAttribute reports whether an attribute holds FILETIME integers.
func IsFileTimeAttribute(name string) bool { return fileTimeAttributes[strings.ToLower(name)] }

// PasswordReason explains 0000052D (ERROR_PASSWORD_RESTRICTION), which AD
// puts in the diagnostic message when the domain's password policy refuses
// a new password. It returns "" for any other message.
func PasswordReason(msg string) string {
	if strings.Contains(strings.ToUpper(msg), "0000052D") {
		return "password does not meet the policy"
	}
	return ""
}
