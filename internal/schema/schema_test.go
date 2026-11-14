// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package schema

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

var testAttrs = []string{
	"( 2.5.4.41 NAME 'name' EQUALITY caseIgnoreMatch SUBSTR caseIgnoreSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{32768} )",
	"( 2.5.4.3 NAME ( 'cn' 'commonName' ) DESC 'RFC4519: common name(s) for which the entity is known by' SUP name )",
	"( 2.5.4.4 NAME ( 'sn' 'surname' ) DESC 'RFC2256: last (family) name(s) for which the entity is known by' SUP name )",
	"( 2.5.4.0 NAME 'objectClass' DESC 'RFC4512: object classes of the entity' EQUALITY objectIdentifierMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.38 )",
	"( 2.5.4.35 NAME 'userPassword' DESC 'RFC4519/2307: password of user' EQUALITY octetStringMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.40{128} )",
	"( 2.5.4.49 NAME 'distinguishedName' EQUALITY distinguishedNameMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.12 )",
	"( 2.5.4.31 NAME 'member' DESC 'RFC2256: member of a group' SUP distinguishedName )",
	"( 0.9.2342.19200300.100.1.60 NAME 'jpegPhoto' DESC 'RFC2798: a JPEG image' SYNTAX 1.3.6.1.4.1.1466.115.121.1.28 )",
	"( 2.5.18.1 NAME 'createTimestamp' DESC 'RFC4512: time which object was created' EQUALITY generalizedTimeMatch ORDERING generalizedTimeOrderingMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.24 SINGLE-VALUE NO-USER-MODIFICATION USAGE directoryOperation )",
	"( 1.2.840.113556.1.4.221 NAME 'sAMAccountName' SYNTAX '1.3.6.1.4.1.1466.115.121.1.15' SINGLE-VALUE )",
	"( 1.2.3 NAME 'broken",
}

var testClasses = []string{
	"( 2.5.6.0 NAME 'top' DESC 'top of the superclass chain' ABSTRACT MUST objectClass )",
	"( 2.5.6.6 NAME 'person' DESC 'RFC2256: a person' SUP top STRUCTURAL MUST ( sn $ cn ) MAY ( userPassword $ telephoneNumber $ seeAlso $ description ) )",
	"( 2.5.6.7 NAME 'organizationalPerson' DESC 'RFC2256: an organizational person' SUP person STRUCTURAL MAY ( title $ x121Address ) )",
	"( 1.1.2 NAME 'extra' SUP top AUXILIARY MAY (cn$mail) )",
}

func TestParseAttributeType(t *testing.T) {
	s := Parse(testAttrs, testClasses, nil)
	got, ok := s.AttributeType("CREATETIMESTAMP")
	if !ok {
		t.Fatal("AttributeType(CREATETIMESTAMP) not found")
	}
	want := &AttributeType{
		OID: "2.5.18.1", Names: []string{"createTimestamp"}, Desc: "RFC4512: time which object was created",
		Syntax: SyntaxGeneralizedTime, SingleValue: true, NoUserModification: true, Usage: "directoryOperation",
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("AttributeType(createTimestamp) mismatch (-want +got):\n%s", diff)
	}
	if at, ok := s.AttributeType("2.5.4.3"); !ok || at.Desc != "RFC4519: common name(s) for which the entity is known by" {
		t.Errorf("AttributeType(2.5.4.3) = %+v, %v, want cn by OID", at, ok)
	}
	if len(s.Skipped) != 1 {
		t.Errorf("Skipped = %q, want the one broken definition", s.Skipped)
	}
}

func TestParseObjectClass(t *testing.T) {
	s := Parse(testAttrs, testClasses, nil)
	got, ok := s.ObjectClass("extra")
	if !ok {
		t.Fatal("ObjectClass(extra) not found")
	}
	want := &ObjectClass{OID: "1.1.2", Names: []string{"extra"}, Sup: []string{"top"}, Kind: Auxiliary, May: []string{"cn", "mail"}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("ObjectClass(extra) mismatch (-want +got):\n%s", diff)
	}
}

func TestSyntaxHelpers(t *testing.T) {
	s := Parse(testAttrs, testClasses, nil)
	tests := []struct {
		name       string
		wantSyntax string
		wantBinary bool
		wantDN     bool
	}{
		{name: "cn", wantSyntax: "1.3.6.1.4.1.1466.115.121.1.15"},
		{name: "member", wantSyntax: SyntaxDN, wantDN: true},
		{name: "jpegPhoto", wantSyntax: "1.3.6.1.4.1.1466.115.121.1.28", wantBinary: true},
		{name: "userCertificate;binary", wantBinary: true},
		{name: "sAMAccountName", wantSyntax: "1.3.6.1.4.1.1466.115.121.1.15"},
		{name: "member;range=0-1499", wantSyntax: SyntaxDN, wantDN: true},
		{name: "unknownAttr"},
	}
	for _, tc := range tests {
		if got := s.Syntax(tc.name); got != tc.wantSyntax {
			t.Errorf("Syntax(%q) = %q, want %q", tc.name, got, tc.wantSyntax)
		}
		if got := s.IsBinary(tc.name); got != tc.wantBinary {
			t.Errorf("IsBinary(%q) = %v, want %v", tc.name, got, tc.wantBinary)
		}
		if got := s.IsDN(tc.name); got != tc.wantDN {
			t.Errorf("IsDN(%q) = %v, want %v", tc.name, got, tc.wantDN)
		}
	}
}

func TestAllowed(t *testing.T) {
	s := Parse(testAttrs, testClasses, nil)
	must, may := s.Allowed([]string{"organizationalPerson", "PERSON", "extra", "unknownClass"})
	if diff := cmp.Diff([]string{"objectClass", "sn", "cn"}, must); diff != "" {
		t.Errorf("Allowed() must mismatch (-want +got):\n%s", diff)
	}
	wantMay := []string{"userPassword", "telephoneNumber", "seeAlso", "description", "title", "x121Address", "mail"}
	if diff := cmp.Diff(wantMay, may); diff != "" {
		t.Errorf("Allowed() may mismatch (-want +got):\n%s", diff)
	}
}

func TestParseEmpty(t *testing.T) {
	s := Parse(nil, nil, nil)
	if _, ok := s.AttributeType("cn"); ok {
		t.Error("empty schema AttributeType(cn) found, want not found")
	}
	if s.IsBinary("cn") {
		t.Error("empty schema IsBinary(cn) = true, want false")
	}
}

func TestParseMalformed(t *testing.T) {
	defs := []string{"", "( )", "( ( )", "( $ )", "( ) )", "( 1.2 NAME )", "( 1.2 NAME ( 'a' )", "1.2 NAME 'a'"}
	for _, d := range defs {
		s := Parse([]string{d}, []string{d}, []string{d})
		if len(s.AttributeTypes) != 0 || len(s.ObjectClasses) != 0 || len(s.ContentRules) != 0 || len(s.Skipped) != 3 {
			t.Errorf("Parse(%q) = %d attribute types, %d object classes, %d content rules, skipped %q, want all skipped",
				d, len(s.AttributeTypes), len(s.ObjectClasses), len(s.ContentRules), s.Skipped)
		}
	}
}

// TestAllowedContentRules mirrors Active Directory, where entries list only
// structural classes and the auxiliary classes come from dITContentRules.
func TestAllowedContentRules(t *testing.T) {
	attrs := []string{
		"( 2.5.4.0 NAME 'objectClass' SYNTAX '1.3.6.1.4.1.1466.115.121.1.38' )",
		"( 2.5.4.3 NAME 'cn' SYNTAX '1.3.6.1.4.1.1466.115.121.1.15' SINGLE-VALUE )",
		"( 2.5.4.12 NAME 'title' SYNTAX '1.3.6.1.4.1.1466.115.121.1.15' SINGLE-VALUE )",
		"( 2.5.4.24 NAME 'x121Address' SYNTAX '1.3.6.1.4.1.1466.115.121.1.36' )",
		"( 0.9.2342.19200300.100.1.3 NAME 'mail' SYNTAX '1.3.6.1.4.1.1466.115.121.1.15' SINGLE-VALUE )",
		"( 1.2.840.113556.1.4.146 NAME 'objectSid' SYNTAX '1.3.6.1.4.1.1466.115.121.1.40' SINGLE-VALUE )",
		"( 1.2.840.113556.1.4.609 NAME 'sIDHistory' SYNTAX '1.3.6.1.4.1.1466.115.121.1.40' )",
		"( 1.2.840.113556.1.4.221 NAME 'sAMAccountName' SYNTAX '1.3.6.1.4.1.1466.115.121.1.15' SINGLE-VALUE )",
		"( 1.2.840.113556.1.2.81 NAME 'info' SYNTAX '1.3.6.1.4.1.1466.115.121.1.15' SINGLE-VALUE )",
		"( 1.2.840.113556.1.2.156 NAME 'comment' SYNTAX '1.3.6.1.4.1.1466.115.121.1.15' SINGLE-VALUE )",
	}
	classes := []string{
		"( 2.5.6.0 NAME 'top' ABSTRACT MUST (objectClass ) )",
		"( 2.5.6.6 NAME 'person' SUP top STRUCTURAL MUST (cn ) )",
		"( 2.5.6.7 NAME 'organizationalPerson' SUP person STRUCTURAL MAY (title $ x121Address ) )",
		"( 1.2.840.113556.1.5.9 NAME 'user' SUP organizationalPerson STRUCTURAL )",
		"( 1.2.840.113556.1.3.46 NAME 'mailRecipient' SUP top AUXILIARY MAY (mail ) )",
		"( 1.2.840.113556.1.5.6 NAME 'securityPrincipal' SUP top AUXILIARY MUST (objectSid ) MAY (sIDHistory ) )",
	}
	rules := []string{
		"( 1.2.840.113556.1.5.9 NAME 'user' AUX ( mailRecipient $ securityPrincipal ) MUST ( objectSid $ sAMAccountName ) MAY ( info $ comment ) NOT ( x121Address ) )",
		"( 1.2.840.113556.1.5.8 NAME 'group' AUX ( mailRecipient",
	}
	s := Parse(attrs, classes, rules)
	if len(s.ContentRules) != 1 || len(s.Skipped) != 1 {
		t.Errorf("Parse() = %d content rules, skipped %q, want 1 rule and the broken group rule skipped", len(s.ContentRules), s.Skipped)
	}
	must, may := s.Allowed([]string{"top", "person", "organizationalPerson", "user"})
	if diff := cmp.Diff([]string{"objectClass", "cn", "objectSid", "sAMAccountName"}, must); diff != "" {
		t.Errorf("Allowed() must mismatch (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff([]string{"title", "mail", "sIDHistory", "info", "comment"}, may); diff != "" {
		t.Errorf("Allowed() may mismatch (-want +got):\n%s", diff)
	}
}
