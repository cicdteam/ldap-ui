// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"slices"

	"github.com/cicdteam/ldap-ui/internal/ldapx"
	"github.com/cicdteam/ldap-ui/internal/profile"
	"github.com/cicdteam/ldap-ui/internal/session"
)

const sessionCookie = "ldapui_session"

type server struct {
	catalog  *profile.Catalog
	dial     Dialer
	sessions *session.Manager[Directory]
	cookies  cookieOptions
	log      *slog.Logger

	identityHeader string
	trustedProxies []netip.Prefix
}

// profileView is a profile as the UI sees it.
type profileView struct {
	profile.Profile
	ReadOnly    bool `json:"readOnly"`
	Editable    bool `json:"editable"`
	HasPassword bool `json:"hasPassword"` // the server can bind without asking
	Connected   bool `json:"connected"`
}

func (s *server) view(p profile.Profile, editable bool, connected map[string]bool) profileView {
	return profileView{
		Profile:     p,
		ReadOnly:    p.IsReadOnly(),
		Editable:    editable,
		HasPassword: p.PasswordEnv != "" || p.PasswordFile != "",
		Connected:   connected[p.Name],
	}
}

func (s *server) listProfiles(w http.ResponseWriter, r *http.Request) {
	fixed, saved := s.catalog.All()
	connected := map[string]bool{}
	for _, n := range s.sessions.Names(sessionID(r)) {
		connected[n] = true
	}
	views := make([]profileView, 0, len(fixed)+len(saved))
	for _, p := range fixed {
		views = append(views, s.view(p, false, connected))
	}
	for _, p := range saved {
		views = append(views, s.view(p, true, connected))
	}
	writeJSON(w, http.StatusOK, views)
}

func (s *server) saveProfile(w http.ResponseWriter, r *http.Request) {
	var p profile.Profile
	if !decode(w, r, &p, maxBody) {
		return
	}
	// ponytail: read before Save, so two saves of one name at once may log a
	// stale oldURL; have Save return the replaced profile if that matters.
	old, _ := s.catalog.Find(p.Name) // the zero Profile, so oldURL "", for a new one
	saved, err := s.catalog.Save(p)
	switch {
	case errors.Is(err, profile.ErrInvalid):
		writeError(w, http.StatusBadRequest, apiError{Code: "invalid_profile", Message: err.Error()})
	case errors.Is(err, profile.ErrFixed):
		writeError(w, http.StatusConflict, apiError{Code: "profile_fixed", Message: err.Error()})
	case errors.Is(err, profile.ErrSavingDisabled):
		writeError(w, http.StatusConflict, apiError{Code: "saving_disabled", Message: err.Error()})
	case errors.Is(err, profile.ErrLimit):
		writeError(w, http.StatusConflict, apiError{Code: "profile_limit", Message: err.Error()})
	case err != nil:
		s.fail(w, err)
	default:
		s.log.Info("profile saved", slices.Concat([]any{
			"name", saved.Name, "oldURL", old.URL, "url", saved.URL,
			"readOnly", saved.IsReadOnly(), "insecureSkipVerify", saved.InsecureSkipVerify,
		}, s.who(r))...)
		writeJSON(w, http.StatusOK, s.view(saved, true, nil))
	}
}

// infoView is a connection's Info plus the profile settings the UI shows as
// badges. They come with the info so the badges never wait on, or vanish
// with, a separate profiles request.
type infoView struct {
	ldapx.Info
	Environment        profile.Environment `json:"environment"`
	ReadOnly           bool                `json:"readOnly"`
	InsecureSkipVerify bool                `json:"insecureSkipVerify"`
	Color              string              `json:"color,omitempty"`
}

func newInfoView(info ldapx.Info, p profile.Profile) infoView {
	return infoView{
		Info:               info,
		Environment:        p.Environment,
		ReadOnly:           p.IsReadOnly(),
		InsecureSkipVerify: p.InsecureSkipVerify,
		Color:              p.Color,
	}
}

type connectRequest struct {
	Profile  string `json:"profile"`
	Password string `json:"password"`
}

func (s *server) connect(w http.ResponseWriter, r *http.Request) {
	var req connectRequest
	if !decode(w, r, &req, maxBody) {
		return
	}
	p, err := s.catalog.Find(req.Profile)
	if err != nil {
		writeError(w, http.StatusNotFound, apiError{Code: "profile_not_found", Message: err.Error()})
		return
	}
	password := req.Password
	if password == "" {
		configured, ok, err := p.ConfiguredPassword()
		if err != nil {
			// err names the env var or file; keep that in the server log.
			s.log.Error("configured password unavailable", "profile", p.Name, "error", err)
			writeError(w, http.StatusInternalServerError, apiError{
				Code:    "password_unavailable",
				Message: "the configured password for this profile is unavailable; see the server log",
			})
			return
		}
		if !ok && p.BindDN != "" {
			writeError(w, http.StatusBadRequest, apiError{Code: "password_required", Message: "this profile needs a password"})
			return
		}
		password = configured
	}
	ctx, cancel := context.WithTimeout(r.Context(), p.ConnectTimeout+p.SearchTimeout)
	defer cancel()
	dir, err := s.dial(ctx, p, password)
	if err != nil {
		s.log.Info("connect failed", s.attributed(r, p, "profile", p.Name, "error", err)...)
		s.fail(w, err)
		return
	}
	// Every connect moves the browser to a new session ID, so an ID that
	// leaked before it reaches no connection. The cookie is set before Put:
	// a refused Put leaves the session, under its new ID, as it was.
	id := s.sessions.Rotate(sessionID(r))
	http.SetCookie(w, s.cookies.cookie(sessionCookie, id, r))
	if err := s.sessions.Put(id, p.Name, dir); err != nil {
		_ = dir.Close()
		s.fail(w, err)
		return
	}
	// Logged under the new ID, the one the browser's next lines carry.
	lr := r.Clone(r.Context())
	lr.Header.Set("Cookie", sessionCookie+"="+id)
	s.log.Info("connected", s.attributed(lr, p, "profile", p.Name)...)
	writeJSON(w, http.StatusOK, newInfoView(dir.Info(), p))
}

func (s *server) disconnect(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Profile string `json:"profile"`
	}
	if !decode(w, r, &req, maxBody) {
		return
	}
	s.sessions.Drop(sessionID(r), req.Profile)
	p, _ := s.catalog.Find(req.Profile) // for the bind DN; "" for an unknown name
	s.log.Info("disconnected", s.attributed(r, p, "profile", req.Profile)...)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) info(w http.ResponseWriter, r *http.Request) {
	d, ok := s.directory(w, r)
	if !ok {
		return
	}
	// The flags come from the current catalog profile, as the profiles list
	// the header used to read: an edit shows without reconnecting. Sessions
	// are keyed by profile name and the catalog never drops a profile, so
	// Find only fails on a bug.
	p, err := s.catalog.Find(r.PathValue("conn"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, newInfoView(d.Info(), p))
}

func (s *server) schema(w http.ResponseWriter, r *http.Request) {
	d, ok := s.directory(w, r)
	if !ok {
		return
	}
	load := d.Schema
	if r.URL.Query().Get("reload") == "true" {
		load = d.ReloadSchema
	}
	sch, err := load(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sch)
}

func (s *server) search(w http.ResponseWriter, r *http.Request) {
	d, ok := s.directory(w, r)
	if !ok {
		return
	}
	var req ldapx.SearchRequest
	if !decode(w, r, &req, maxBody) {
		return
	}
	if req.BaseDN == "" {
		req.BaseDN = d.Info().BaseDN
	}
	page, err := d.Search(r.Context(), req)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *server) entry(w http.ResponseWriter, r *http.Request) {
	d, ok := s.directory(w, r)
	if !ok {
		return
	}
	dn, ok := requireDN(w, r)
	if !ok {
		return
	}
	e, err := d.Entry(r.Context(), dn)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (s *server) memberOf(w http.ResponseWriter, r *http.Request) { s.refs(w, r, Directory.MemberOf) }

func (s *server) members(w http.ResponseWriter, r *http.Request) { s.refs(w, r, Directory.Members) }

func (s *server) refs(w http.ResponseWriter, r *http.Request, list func(Directory, context.Context, string, bool) (ldapx.Membership, error)) {
	d, ok := s.directory(w, r)
	if !ok {
		return
	}
	dn, ok := requireDN(w, r)
	if !ok {
		return
	}
	m, err := list(d, r.Context(), dn, r.URL.Query().Get("nested") == "true")
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// directory returns the connection named by the {conn} path segment, or
// writes an error and returns false.
func (s *server) directory(w http.ResponseWriter, r *http.Request) (Directory, bool) {
	d, err := s.sessions.Get(sessionID(r), r.PathValue("conn"))
	if err != nil {
		s.fail(w, err)
		return nil, false
	}
	return d, true
}

func (s *server) fail(w http.ResponseWriter, err error) {
	status, body := errorResponse(err)
	if status == http.StatusInternalServerError {
		s.log.Error("request failed", "error", err)
	}
	writeError(w, status, body)
}

func sessionID(r *http.Request) string {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	return c.Value
}

func requireDN(w http.ResponseWriter, r *http.Request) (string, bool) {
	dn := r.URL.Query().Get("dn")
	if dn == "" {
		writeError(w, http.StatusBadRequest, apiError{Code: "bad_request", Message: "dn query parameter is required"})
		return "", false
	}
	return dn, true
}

// Request body limits: a batch or a new entry may carry binary values, up to
// ldapx.MaxValue each once decoded; every other body stays small.
const (
	maxBody      = 1 << 20
	maxWriteBody = 8 << 20
)

// decode reads a JSON body of at most limit bytes into v, rejecting unknown
// fields so the UI cannot smuggle in config-only settings such as
// passwordFile.
func decode(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, apiError{Code: "bad_request", Message: "invalid JSON body: " + err.Error()})
		return false
	}
	return true
}
