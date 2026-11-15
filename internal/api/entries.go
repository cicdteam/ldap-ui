// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-ldap/ldap/v3"

	"github.com/cicdteam/ldap-ui/internal/ldapx"
	"github.com/cicdteam/ldap-ui/internal/profile"
	"github.com/cicdteam/ldap-ui/internal/schema"
)

type addRequest struct {
	confirmation
	DN         string                `json:"dn"`
	Attributes []ldapx.TextAttribute `json:"attributes"`
}

type deleteRequest struct {
	confirmation
	DN string `json:"dn"`
}

type renameRequest struct {
	confirmation
	DN     string `json:"dn"`
	NewRDN string `json:"newRDN"`
	// NewParent moves the entry; empty keeps its parent.
	NewParent string `json:"newParent"`
	// KeepOldRDN keeps the old RDN value as an attribute value.
	KeepOldRDN bool `json:"keepOldRDN"`
}

type passwordRequest struct {
	confirmation
	DN       string `json:"dn"`
	Password string `json:"password"`
	// Method is "server" (Password Modify) or "ssha"; AD ignores it.
	Method string `json:"method"`
}

// maxPassword bounds a new password, in bytes.
const maxPassword = 512

// writeResult is the DN an add, delete, rename or password change wrote.
type writeResult struct {
	DN string `json:"dn"`
}

// addEntry creates one entry with one LDAP add.
func (s *server) addEntry(w http.ResponseWriter, r *http.Request) {
	var req addRequest
	var sch *schema.Schema
	d, p, ok := s.guard(w, r, &req, maxWriteBody, func(d Directory) (apiError, bool) {
		sch = schemaOf(r.Context(), d)
		return validateAdd(req, sch)
	})
	if !ok {
		return
	}
	if err := d.Add(r.Context(), req.DN, req.Attributes); err != nil {
		names := make([]string, len(req.Attributes))
		for i, a := range req.Attributes {
			names[i] = a.Name
		}
		s.failWrite(w, "add", p, sch, req.DN, err, names, "attributes", len(req.Attributes))
		return
	}
	s.log.Info("added", "profile", p.Name, "dn", logDN(req.DN, sch), "attributes", len(req.Attributes))
	writeJSON(w, http.StatusOK, writeResult{DN: req.DN})
}

// deleteEntry removes one leaf entry.
func (s *server) deleteEntry(w http.ResponseWriter, r *http.Request) {
	var req deleteRequest
	var sch *schema.Schema
	d, p, ok := s.guard(w, r, &req, maxBody, func(d Directory) (apiError, bool) {
		sch = schemaOf(r.Context(), d) // for logDN
		return validateDN(req.DN)
	})
	if !ok {
		return
	}
	if err := d.Delete(r.Context(), req.DN); err != nil {
		s.failWrite(w, "delete", p, sch, req.DN, err, nil)
		return
	}
	s.log.Info("deleted", "profile", p.Name, "dn", logDN(req.DN, sch))
	writeJSON(w, http.StatusOK, writeResult{DN: req.DN})
}

// renameEntry renames or moves one entry with one LDAP modrdn.
func (s *server) renameEntry(w http.ResponseWriter, r *http.Request) {
	var req renameRequest
	var sch *schema.Schema
	d, p, ok := s.guard(w, r, &req, maxBody, func(d Directory) (apiError, bool) {
		sch = schemaOf(r.Context(), d)
		return validateRename(req, sch)
	})
	if !ok {
		return
	}
	to := renamed(req)
	err := d.Rename(r.Context(), req.DN, strings.TrimSpace(req.NewRDN), strings.TrimSpace(req.NewParent), !req.KeepOldRDN)
	if err != nil {
		s.failWrite(w, "rename", p, sch, req.DN, err, nil, "newDN", logDN(to, sch))
		return
	}
	s.log.Info("renamed", "profile", p.Name, "dn", logDN(req.DN, sch), "newDN", logDN(to, sch))
	writeJSON(w, http.StatusOK, writeResult{DN: to})
}

// setPassword sets an entry's password at once; it is never staged. Neither
// the password nor the request body is logged.
func (s *server) setPassword(w http.ResponseWriter, r *http.Request) {
	var req passwordRequest
	var sch *schema.Schema
	d, p, ok := s.guard(w, r, &req, maxBody, func(d Directory) (apiError, bool) {
		sch = schemaOf(r.Context(), d) // for logDN
		return validatePassword(req, d.Info())
	})
	if !ok {
		return
	}
	method := req.Method
	if d.Info().ActiveDirectory {
		method = "unicodePwd"
	}
	if err := d.SetPassword(r.Context(), req.DN, req.Password, req.Method); err != nil {
		s.failWrite(w, "password", p, sch, req.DN, err, nil, "method", method)
		return
	}
	s.log.Info("password set", "profile", p.Name, "dn", logDN(req.DN, sch), "method", method)
	writeJSON(w, http.StatusOK, writeResult{DN: req.DN})
}

// failWrite answers a failed entry write with rejected's response; see
// rejected for names and fields.
func (s *server) failWrite(w http.ResponseWriter, op string, p profile.Profile, sch *schema.Schema, dn string, err error, names []string, fields ...any) {
	status, body := s.rejected(op, p, sch, dn, err, names, fields...)
	writeError(w, status, body)
}

// validateAdd checks a new entry before anything is written or logged.
func validateAdd(req addRequest, sch *schema.Schema) (apiError, bool) {
	if e, ok := validateDN(req.DN); !ok {
		return e, false
	}
	dn, err := ldap.ParseDN(req.DN)
	if err != nil {
		return bad("", "dn is not a valid DN")
	}
	if t := secretType(dn.RDNs[0], sch); t != "" {
		return bad(t, t+" is secret and cannot name an entry")
	}
	if len(req.Attributes) == 0 {
		return bad("", "a new entry needs attributes")
	}
	seen := make(map[string]bool, len(req.Attributes))
	for _, a := range req.Attributes {
		key := foldKey(a.Name)
		switch {
		case a.Name == "":
			return bad("", "an attribute has no name")
		case seen[key]:
			return bad(a.Name, a.Name+" is listed twice")
		case ldapx.IsSecret(a.Name, sch):
			return bad(a.Name, a.Name+" cannot be set here")
		case len(a.Values) == 0:
			return bad(a.Name, a.Name+": no values")
		}
		if r, ok := validateValues(a.Name, a.Values, a.Base64); !ok {
			return r, false
		}
		seen[key] = true
	}
	if !seen[foldKey("objectClass")] {
		return bad("", "a new entry needs an objectClass")
	}
	return apiError{}, true
}

// secretType is the first attribute type of rdn that is secret, or "". An
// RDN's value is written to the entry and its DN is logged, so a secret must
// never name one.
func secretType(rdn *ldap.RelativeDN, sch *schema.Schema) string {
	for _, a := range rdn.Attributes {
		if ldapx.IsSecret(a.Type, sch) {
			return a.Type
		}
	}
	return ""
}

// logDN is dn as every write logs it: "<redacted>" when go-ldap cannot parse
// it or any of its RDNs has a secret attribute type, whose value must never
// reach the log.
func logDN(dn string, sch *schema.Schema) string {
	parsed, err := ldap.ParseDN(dn)
	if err != nil {
		return "<redacted>"
	}
	for _, rdn := range parsed.RDNs {
		if secretType(rdn, sch) != "" {
			return "<redacted>"
		}
	}
	return dn
}

func validateDN(dn string) (apiError, bool) {
	if strings.TrimSpace(dn) == "" {
		return bad("", "dn is required")
	}
	return apiError{}, true
}

// validateRename refuses a new RDN that is not one RDN or names a secret
// attribute, a new parent that is the entry or lies below it, and a rename to
// the same DN. The parent check ignores case and the spaces around "," and
// "="; the same-DN check compares strings exactly, so a case-only rename
// (cn=john to cn=John) is allowed.
func validateRename(req renameRequest, sch *schema.Schema) (apiError, bool) {
	if e, ok := validateDN(req.DN); !ok {
		return e, false
	}
	rdn := strings.TrimSpace(req.NewRDN)
	if rdn == "" {
		return bad("", "newRDN is required")
	}
	parsed, err := ldap.ParseDN(rdn)
	if err != nil || len(parsed.RDNs) != 1 {
		return bad("", "newRDN must be one RDN such as cn=Name")
	}
	if t := secretType(parsed.RDNs[0], sch); t != "" {
		return bad(t, t+" is secret and cannot name an entry")
	}
	from, err := ldap.ParseDN(req.DN)
	if err != nil {
		return bad("", "dn is not a valid DN")
	}
	if parent := strings.TrimSpace(req.NewParent); parent != "" {
		to, err := ldap.ParseDN(parent)
		if err != nil {
			return bad("", "newParent is not a valid DN")
		}
		if to.EqualFold(from) || from.AncestorOfFold(to) {
			return bad("", "an entry cannot move below itself")
		}
	}
	if renamed(req) == strings.TrimSpace(req.DN) {
		return bad("", "the new DN is the current one")
	}
	return apiError{}, true
}

// validatePassword checks a new password and its method against what the
// server offers, before anything is written or logged.
func validatePassword(req passwordRequest, info ldapx.Info) (apiError, bool) {
	if e, ok := validateDN(req.DN); !ok {
		return e, false
	}
	if _, err := ldap.ParseDN(req.DN); err != nil {
		return bad("", "dn is not a valid DN")
	}
	switch {
	case req.Password == "":
		return bad("", "password is required")
	case len(req.Password) > maxPassword:
		return bad("", fmt.Sprintf("password is longer than %d bytes", maxPassword))
	case info.ActiveDirectory && !info.Encrypted:
		return bad("", "Active Directory accepts passwords only over an encrypted connection")
	case info.ActiveDirectory:
		// unicodePwd is the only way; the method does not apply.
	case req.Method != "server" && req.Method != "ssha":
		return bad("", `method must be "server" or "ssha"`)
	case req.Method == "server" && !info.PasswordModify:
		return bad("", "the server does not offer Password Modify; use ssha")
	}
	return apiError{}, true
}

// renamed is the DN a rename gives: the new RDN under the new parent, or
// under the old parent as the client spelled it.
func renamed(req renameRequest) string {
	rdn := strings.TrimSpace(req.NewRDN)
	parent := strings.TrimSpace(req.NewParent)
	if parent == "" {
		parent = parentOf(req.DN)
	}
	if parent == "" {
		return rdn
	}
	return rdn + "," + parent
}

// parentOf is dn without its first RDN, spelled as in dn.
func parentOf(dn string) string {
	for i := 0; i < len(dn); i++ {
		switch dn[i] {
		case '\\':
			i++ // the escaped character, or the first hex digit of \XX
		case ',':
			return strings.TrimSpace(dn[i+1:])
		}
	}
	return ""
}
