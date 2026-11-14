// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

// Package schema parses LDAP subschema definitions (RFC 4512) as published by
// OpenLDAP and Active Directory.
package schema

import (
	"errors"
	"fmt"
	"strings"
)

// Kind is the kind of an object class.
type Kind string

// Object class kinds.
const (
	Structural Kind = "STRUCTURAL"
	Auxiliary  Kind = "AUXILIARY"
	Abstract   Kind = "ABSTRACT"
)

// Well-known syntax OIDs.
const (
	SyntaxDN              = "1.3.6.1.4.1.1466.115.121.1.12"
	SyntaxGeneralizedTime = "1.3.6.1.4.1.1466.115.121.1.24"
)

// binarySyntaxes are syntaxes whose values are not text: audio, binary,
// certificate, certificate list, certificate pair, JPEG, octet string.
var binarySyntaxes = map[string]bool{
	"1.3.6.1.4.1.1466.115.121.1.4":  true,
	"1.3.6.1.4.1.1466.115.121.1.5":  true,
	"1.3.6.1.4.1.1466.115.121.1.8":  true,
	"1.3.6.1.4.1.1466.115.121.1.9":  true,
	"1.3.6.1.4.1.1466.115.121.1.10": true,
	"1.3.6.1.4.1.1466.115.121.1.28": true,
	"1.3.6.1.4.1.1466.115.121.1.40": true,
}

// AttributeType is one parsed attributeTypes value.
type AttributeType struct {
	OID                string   `json:"oid"`
	Names              []string `json:"names,omitempty"`
	Desc               string   `json:"desc,omitempty"`
	Sup                string   `json:"sup,omitempty"`
	Syntax             string   `json:"syntax,omitempty"` // declared syntax only; see Schema.Syntax
	SingleValue        bool     `json:"singleValue,omitempty"`
	NoUserModification bool     `json:"noUserModification,omitempty"`
	Usage              string   `json:"usage,omitempty"`
}

// ObjectClass is one parsed objectClasses value.
type ObjectClass struct {
	OID   string   `json:"oid"`
	Names []string `json:"names,omitempty"`
	Desc  string   `json:"desc,omitempty"`
	Sup   []string `json:"sup,omitempty"`
	Kind  Kind     `json:"kind"`
	Must  []string `json:"must,omitempty"`
	May   []string `json:"may,omitempty"`
}

// ContentRule is one parsed dITContentRules value. Its OID is the OID of the
// structural class it governs. Active Directory uses these rules to attach
// auxiliary classes that entries do not list in objectClass.
type ContentRule struct {
	OID   string   `json:"oid"`
	Names []string `json:"names,omitempty"`
	Aux   []string `json:"aux,omitempty"`
	Must  []string `json:"must,omitempty"`
	May   []string `json:"may,omitempty"`
	Not   []string `json:"not,omitempty"`
}

// Schema is a parsed subschema, indexed by lower-cased name and OID.
type Schema struct {
	AttributeTypes []*AttributeType `json:"attributeTypes"`
	ObjectClasses  []*ObjectClass   `json:"objectClasses"`
	ContentRules   []*ContentRule   `json:"contentRules,omitempty"`
	// Skipped lists definitions that could not be parsed, so the UI can warn.
	Skipped []string `json:"skipped,omitempty"`

	attrs   map[string]*AttributeType
	classes map[string]*ObjectClass
	rules   map[string]*ContentRule
}

// Parse builds a Schema from the raw attributeTypes, objectClasses and
// dITContentRules values of a subschema entry. Malformed definitions are
// recorded in Skipped rather than failing the whole schema, because real
// servers ship odd extensions.
func Parse(attributeTypes, objectClasses, dITContentRules []string) *Schema {
	s := &Schema{attrs: map[string]*AttributeType{}, classes: map[string]*ObjectClass{}, rules: map[string]*ContentRule{}}
	for _, d := range attributeTypes {
		at, err := parseAttributeType(d)
		if err != nil {
			s.Skipped = append(s.Skipped, fmt.Sprintf("%s: %v", d, err))
			continue
		}
		s.AttributeTypes = append(s.AttributeTypes, at)
		s.attrs[strings.ToLower(at.OID)] = at
		for _, n := range at.Names {
			s.attrs[strings.ToLower(n)] = at
		}
	}
	for _, d := range objectClasses {
		oc, err := parseObjectClass(d)
		if err != nil {
			s.Skipped = append(s.Skipped, fmt.Sprintf("%s: %v", d, err))
			continue
		}
		s.ObjectClasses = append(s.ObjectClasses, oc)
		s.classes[strings.ToLower(oc.OID)] = oc
		for _, n := range oc.Names {
			s.classes[strings.ToLower(n)] = oc
		}
	}
	for _, d := range dITContentRules {
		cr, err := parseContentRule(d)
		if err != nil {
			s.Skipped = append(s.Skipped, fmt.Sprintf("%s: %v", d, err))
			continue
		}
		s.ContentRules = append(s.ContentRules, cr)
		s.rules[strings.ToLower(cr.OID)] = cr
		for _, n := range cr.Names {
			s.rules[strings.ToLower(n)] = cr
		}
	}
	return s
}

// AttributeType looks up an attribute by name or OID, ignoring case and
// attribute options such as ";binary" or ";range=0-1499".
func (s *Schema) AttributeType(name string) (*AttributeType, bool) {
	at, ok := s.attrs[strings.ToLower(baseName(name))]
	return at, ok
}

// ObjectClass looks up an object class by name or OID, ignoring case.
func (s *Schema) ObjectClass(name string) (*ObjectClass, bool) {
	oc, ok := s.classes[strings.ToLower(name)]
	return oc, ok
}

// Syntax returns the syntax OID of an attribute, following SUP when the type
// inherits its syntax (cn inherits from name, member from distinguishedName).
// It returns "" for unknown attributes.
func (s *Schema) Syntax(name string) string {
	at, ok := s.AttributeType(name)
	for depth := 0; ok && depth < 16; depth++ {
		if at.Syntax != "" {
			return at.Syntax
		}
		if at.Sup == "" {
			break
		}
		at, ok = s.AttributeType(at.Sup)
	}
	return ""
}

// IsBinary reports whether values of the attribute are not text.
func (s *Schema) IsBinary(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), ";binary") || binarySyntaxes[s.Syntax(name)]
}

// IsDN reports whether values of the attribute are DNs.
func (s *Schema) IsDN(name string) bool {
	return s.Syntax(name) == SyntaxDN
}

// Allowed returns the MUST and MAY attributes for an entry with the given
// object classes, including those inherited through SUP. When a visited
// class has a dITContentRule (Active Directory publishes them), the rule's
// AUX classes and its own MUST and MAY count too, and attributes the rule
// lists in NOT are dropped from may (NOT never removes a MUST). Names are
// canonical (first NAME of the type) and an attribute required by any class
// is never listed in may. Unknown classes are ignored.
func (s *Schema) Allowed(objectClasses []string) (must, may []string) {
	visited := map[string]bool{}
	inMust, inMay, notMay := map[string]bool{}, map[string]bool{}, map[string]bool{}
	var mayAll []string
	add := func(attrs []string, seen map[string]bool, out *[]string) {
		for _, a := range attrs {
			a = s.canonical(a)
			if key := strings.ToLower(a); !seen[key] {
				seen[key] = true
				*out = append(*out, a)
			}
		}
	}
	var visit func(name string)
	visit = func(name string) {
		oc, ok := s.ObjectClass(name)
		if !ok || visited[oc.OID] {
			return
		}
		visited[oc.OID] = true
		for _, sup := range oc.Sup {
			visit(sup)
		}
		add(oc.Must, inMust, &must)
		add(oc.May, inMay, &mayAll)
		cr, ok := s.rules[strings.ToLower(oc.OID)]
		if !ok {
			return
		}
		for _, aux := range cr.Aux {
			visit(aux)
		}
		add(cr.Must, inMust, &must)
		add(cr.May, inMay, &mayAll)
		for _, a := range cr.Not {
			notMay[strings.ToLower(s.canonical(a))] = true
		}
	}
	for _, name := range objectClasses {
		visit(name)
	}
	for _, a := range mayAll {
		if key := strings.ToLower(a); !inMust[key] && !notMay[key] {
			may = append(may, a)
		}
	}
	return must, may
}

func (s *Schema) canonical(name string) string {
	if at, ok := s.AttributeType(name); ok && len(at.Names) > 0 {
		return at.Names[0]
	}
	return name
}

// baseName strips attribute options: "member;range=0-1499" -> "member".
func baseName(name string) string {
	n, _, _ := strings.Cut(name, ";")
	return n
}

func parseAttributeType(def string) (*AttributeType, error) {
	oid, f, err := parseDef(def)
	if err != nil {
		return nil, err
	}
	at := &AttributeType{
		OID:    oid,
		Names:  f["NAME"],
		Desc:   first(f["DESC"]),
		Sup:    first(f["SUP"]),
		Syntax: stripLength(first(f["SYNTAX"])),
		Usage:  first(f["USAGE"]),
	}
	_, at.SingleValue = f["SINGLE-VALUE"]
	_, at.NoUserModification = f["NO-USER-MODIFICATION"]
	return at, nil
}

func parseObjectClass(def string) (*ObjectClass, error) {
	oid, f, err := parseDef(def)
	if err != nil {
		return nil, err
	}
	oc := &ObjectClass{OID: oid, Names: f["NAME"], Desc: first(f["DESC"]), Sup: f["SUP"], Kind: Structural, Must: f["MUST"], May: f["MAY"]}
	for _, k := range []Kind{Auxiliary, Abstract} {
		if _, ok := f[string(k)]; ok {
			oc.Kind = k
		}
	}
	return oc, nil
}

func parseContentRule(def string) (*ContentRule, error) {
	oid, f, err := parseDef(def)
	if err != nil {
		return nil, err
	}
	return &ContentRule{OID: oid, Names: f["NAME"], Aux: f["AUX"], Must: f["MUST"], May: f["MAY"], Not: f["NOT"]}, nil
}

// flagKeywords take no value.
var flagKeywords = map[string]bool{
	"SINGLE-VALUE": true, "COLLECTIVE": true, "NO-USER-MODIFICATION": true, "OBSOLETE": true,
	"STRUCTURAL": true, "AUXILIARY": true, "ABSTRACT": true,
}

// parseDef parses "( oid KEYWORD value KEYWORD ( v1 $ v2 ) FLAG ... )" into
// the OID and a map from keyword to values. Flags map to a nil slice.
func parseDef(def string) (string, map[string][]string, error) {
	toks, err := tokenize(def)
	if err != nil {
		return "", nil, err
	}
	if len(toks) < 3 || !toks[0].is("(") || !toks[len(toks)-1].is(")") {
		return "", nil, errors.New("definition must be enclosed in parentheses")
	}
	toks = toks[1 : len(toks)-1]
	if toks[0].is("(") || toks[0].is(")") || toks[0].is("$") {
		return "", nil, errors.New("missing OID")
	}
	oid := toks[0].text
	fields := map[string][]string{}
	for i := 1; i < len(toks); {
		key := toks[i].text
		i++
		if flagKeywords[key] {
			fields[key] = nil
			continue
		}
		if i >= len(toks) {
			return "", nil, fmt.Errorf("%s has no value", key)
		}
		if !toks[i].is("(") {
			fields[key] = append(fields[key], toks[i].text)
			i++
			continue
		}
		for i++; i < len(toks) && !toks[i].is(")"); i++ {
			if !toks[i].is("$") {
				fields[key] = append(fields[key], toks[i].text)
			}
		}
		if i >= len(toks) {
			return "", nil, fmt.Errorf("%s: unclosed list", key)
		}
		i++
	}
	return oid, fields, nil
}

type token struct {
	text   string
	quoted bool
}

// is reports whether t is the unquoted punctuation p.
func (t token) is(p string) bool { return !t.quoted && t.text == p }

// tokenize splits a definition into parentheses, "$", quoted strings and
// bare words. Quoted strings lose their quotes.
// ponytail: RFC 4512 escapes inside quoted strings (\27, \5C) are kept
// verbatim; decode them if a server ever ships one in a NAME.
func tokenize(s string) ([]token, error) {
	var toks []token
	for i := 0; i < len(s); {
		switch c := s[i]; c {
		case ' ', '\t', '\n', '\r':
			i++
		case '(', ')', '$':
			toks = append(toks, token{text: string(c)})
			i++
		case '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return nil, errors.New("unterminated quoted string")
			}
			toks = append(toks, token{text: s[i+1 : i+1+j], quoted: true})
			i += j + 2
		default:
			j := i
			for j < len(s) && !strings.ContainsRune(" \t\r\n()$'", rune(s[j])) {
				j++
			}
			toks = append(toks, token{text: s[i:j]})
			i = j
		}
	}
	return toks, nil
}

func first(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}

// stripLength drops a length bound: "1.3.6...15{32768}" -> "1.3.6...15".
func stripLength(syntax string) string {
	s, _, _ := strings.Cut(syntax, "{")
	return s
}
