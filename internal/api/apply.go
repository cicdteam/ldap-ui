// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"context"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/cicdteam/ldap-ui/internal/ldapx"
	"github.com/cicdteam/ldap-ui/internal/profile"
	"github.com/cicdteam/ldap-ui/internal/schema"
)

// confirmation is part of every write request body.
type confirmation struct {
	// Confirm must equal the profile name for prod profiles.
	Confirm string `json:"confirm"`
}

func (c confirmation) typed() string { return c.Confirm }

// writeRequest is a write request body; every one embeds confirmation.
type writeRequest interface{ typed() string }

type applyRequest struct {
	confirmation
	Entries []applyEntry `json:"entries"`
}

type applyEntry struct {
	DN      string         `json:"dn"`
	Changes []ldapx.Change `json:"changes"`
}

type applyResult struct {
	Applied []string      `json:"applied"`
	Failed  *applyFailure `json:"failed,omitempty"`
}

type applyFailure struct {
	DN    string   `json:"dn"`
	Error apiError `json:"error"`
}

// guard runs the checks every write shares, in this order: a session for
// {conn}; a writable profile (403 read_only), read from the catalog so that
// an edit applies without reconnecting; a body of at most limit bytes that
// decodes into req (400); validate (400 bad_request); on prod, the profile
// name in confirm (409 confirmation_required). It writes the first refusal
// and returns false, so nothing is written before every check has passed.
func (s *server) guard(w http.ResponseWriter, r *http.Request, req writeRequest, limit int64, validate func(Directory) (apiError, bool)) (Directory, profile.Profile, bool) {
	d, ok := s.directory(w, r)
	if !ok {
		return nil, profile.Profile{}, false
	}
	p, err := s.catalog.Find(r.PathValue("conn"))
	if err != nil {
		s.fail(w, err)
		return nil, profile.Profile{}, false
	}
	refuse := func(status int, e apiError) (Directory, profile.Profile, bool) {
		writeError(w, status, e)
		return nil, profile.Profile{}, false
	}
	if p.IsReadOnly() {
		return refuse(http.StatusForbidden, apiError{Code: "read_only", Message: "this profile is read-only"})
	}
	if !decode(w, r, req, limit) {
		return nil, profile.Profile{}, false
	}
	if e, ok := validate(d); !ok {
		return refuse(http.StatusBadRequest, e)
	}
	if p.Environment == profile.Prod && req.typed() != p.Name {
		return refuse(http.StatusConflict, apiError{
			Code:    "confirmation_required",
			Message: "type the connection name to write to a prod profile",
		})
	}
	return d, p, true
}

// schemaOf is the session's schema, or an empty one when it cannot be read:
// secret attributes are then still caught by name.
func schemaOf(ctx context.Context, d Directory) *schema.Schema {
	sch, err := d.Schema(ctx)
	if err != nil {
		return schema.Parse(nil, nil, nil)
	}
	return sch
}

// bad is a 400 bad_request about attr, or about the whole request when attr
// is empty.
func bad(attr, msg string) (apiError, bool) {
	return apiError{Code: "bad_request", Message: msg, Attribute: attr}, false
}

// apply runs a batch of modifies in order, one atomic LDAP modify per entry,
// and stops at the first failure. A partial result is a 200: the client
// drops the applied entries from its batch and keeps the failed one.
func (s *server) apply(w http.ResponseWriter, r *http.Request) {
	var req applyRequest
	var sch *schema.Schema
	d, p, ok := s.guard(w, r, &req, maxWriteBody, func(d Directory) (apiError, bool) {
		sch = schemaOf(r.Context(), d)
		return validateApply(req, sch)
	})
	if !ok {
		return
	}
	res := applyResult{Applied: []string{}}
	for _, e := range req.Entries {
		if err := d.Modify(r.Context(), e.DN, e.Changes); err != nil {
			_, body := s.rejected("modify", p, sch, e.DN, err, changeAttrs(e.Changes), "changes", len(e.Changes))
			res.Failed = &applyFailure{DN: e.DN, Error: body}
			break
		}
		s.log.Info("modified", "profile", p.Name, "dn", logDN(e.DN, sch), "changes", len(e.Changes))
		res.Applied = append(res.Applied, e.DN)
	}
	writeJSON(w, http.StatusOK, res)
}

// rejected maps a failed write of dn to its response and logs it, once for
// every write. names are the attributes the request wrote: a conflict or a
// rejection names the one it was about, while a network error, a timeout or
// a missing entry is about the whole entry. fields are extra slog key/value
// pairs for both logs, never attribute values; a DN among them goes through
// logDN first.
func (s *server) rejected(op string, p profile.Profile, sch *schema.Schema, dn string, err error, names []string, fields ...any) (int, apiError) {
	log := s.log.With(append([]any{"profile", p.Name, "dn", logDN(dn, sch)}, fields...)...)
	status, body := errorResponse(err)
	if status == http.StatusInternalServerError {
		log.Error(op+" failed", "error", err)
	}
	if body.Code == "conflict" || body.Code == "rejected" {
		body.Attribute = blame(names, body.Diagnostic)
	}
	log.Info(op+" rejected", "code", body.Code, "ldapResultCode", body.LDAPResultCode)
	return status, body
}

// validateApply checks the whole batch before anything is written.
func validateApply(req applyRequest, sch *schema.Schema) (apiError, bool) {
	if len(req.Entries) == 0 {
		return bad("", "no entries to change")
	}
	for _, e := range req.Entries {
		if strings.TrimSpace(e.DN) == "" {
			return bad("", "an entry has no DN")
		}
		if len(e.Changes) == 0 {
			return bad("", "entry "+e.DN+" has no changes")
		}
		for _, c := range e.Changes {
			switch {
			case c.Attr == "":
				return bad("", "a change in "+e.DN+" has no attribute")
			case c.Op != "add" && c.Op != "delete":
				return bad(c.Attr, "unknown operation "+c.Op)
			case ldapx.IsSecret(c.Attr, sch):
				return bad(c.Attr, c.Attr+" cannot be changed here")
			case len(c.Values) == 0:
				return bad(c.Attr, c.Attr+": no values")
			}
			if r, ok := validateValues(c.Attr, c.Values, c.Base64); !ok {
				return r, false
			}
		}
	}
	return apiError{}, true
}

// validateValues refuses an empty value, base64 that does not decode and a
// value over ldapx.MaxValue bytes once decoded (text values count as they
// are). The messages never hold a value.
func validateValues(attr string, values []string, b64 bool) (apiError, bool) {
	if slices.Contains(values, "") {
		return bad(attr, attr+": empty value")
	}
	raw, err := ldapx.RawValues(values, b64)
	if err != nil {
		return bad(attr, attr+": value is not base64")
	}
	for _, v := range raw {
		if len(v) > ldapx.MaxValue {
			return bad(attr, attr+": value is larger than 1 MiB")
		}
	}
	return apiError{}, true
}

// changeAttrs lists the attribute of each change, for blame.
func changeAttrs(changes []ldapx.Change) []string {
	attrs := make([]string, len(changes))
	for i, c := range changes {
		attrs[i] = c.Attr
	}
	return attrs
}

// blame names the attribute a failed write was about: the only one among
// names, or the one the server's diagnostic names (OpenLDAP writes
// "modify/add: cn;lang-de: ..."). A full name wins, so cn;lang-de is never
// taken for cn; then a name's type alone, for servers that print only the
// type. Empty when it cannot tell.
func blame(names []string, diagnostic string) string {
	var attrs []string
	for _, n := range names {
		if !containsFold(attrs, n) {
			attrs = append(attrs, n)
		}
	}
	if len(attrs) == 1 {
		return attrs[0]
	}
	for _, a := range attrs {
		if mentions(diagnostic, a) {
			return a
		}
	}
	for _, a := range attrs {
		if base, _, ok := strings.Cut(a, ";"); ok && mentions(diagnostic, base) {
			return a
		}
	}
	return ""
}

// mentions reports whether diagnostic names attr as a whole: not inside a
// longer name and not followed by options.
func mentions(diagnostic, attr string) bool {
	return regexp.MustCompile(`(?i)(^|[^\w-])` + regexp.QuoteMeta(attr) + `($|[^\w;-])`).MatchString(diagnostic)
}

func containsFold(list []string, s string) bool {
	for _, x := range list {
		if strings.EqualFold(x, s) {
			return true
		}
	}
	return false
}
