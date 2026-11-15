// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/go-ldap/ldap/v3"

	"github.com/cicdteam/ldap-ui/internal/schema"
)

type result struct {
	entries   []*ldap.Entry
	referrals []string
	controls  []ldap.Control
	truncated bool
}

// searchOnce sends one search request and collects its results. Size and
// time limit errors are not failures: they set truncated and keep what
// arrived. A connection that is closing yields an ErrorNetwork error so that
// read can redial, and so does a lost one (see networkError).
func searchOnce(ctx context.Context, lc *ldap.Conn, req *ldap.SearchRequest) (*result, error) {
	resp := lc.SearchAsync(ctx, req, 64)
	res := &result{}
	for resp.Next() {
		if e := resp.Entry(); e != nil {
			res.entries = append(res.entries, e)
		}
		if r := resp.Referral(); r != "" {
			res.referrals = append(res.referrals, r)
		}
		if ctls := resp.Controls(); len(ctls) > 0 {
			res.controls = ctls
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	err := resp.Err()
	switch {
	case ldap.IsErrorWithCode(err, ldap.LDAPResultSizeLimitExceeded), ldap.IsErrorWithCode(err, ldap.LDAPResultTimeLimitExceeded):
		res.truncated = true
		return res, nil
	case err != nil:
		return nil, networkError(err)
	case lc.IsClosing():
		return nil, ldap.NewError(ldap.ErrorNetwork, errors.New("connection closed"))
	}
	return res, nil
}

// searchTimeLimit is the server-side time limit in seconds for a client
// timeout of d. It stays below d so that a slow search ends with what was
// found so far (timeLimitExceeded, reported as truncated) rather than with
// a client timeout and nothing.
func searchTimeLimit(d time.Duration) int {
	return max(1, int((d-2*time.Second)/time.Second))
}

// Search runs one page of a search. On servers with paging, Page.Cursor is
// an opaque ID for the next page. It works once and fails with
// ErrCursorExpired after cursorIdle without use or when more than
// maxCursors listings are open on c. A filter that matches on a secret
// attribute's value fails with ErrSecretFilter before the search is sent.
func (c *Conn) Search(ctx context.Context, r SearchRequest) (Page, error) {
	req, err := buildRequest(r, c.info.Paging)
	if err != nil {
		return Page{}, err
	}
	s := c.schemaOrEmpty(ctx)
	// ponytail: compiles the filter a second time after buildRequest;
	// maxFilterLength bounds the cost.
	attr, err := secretFilterAttr(req.Filter, s)
	if err != nil {
		return Page{}, err
	}
	if attr != "" {
		return Page{}, fmt.Errorf("%w: %s", ErrSecretFilter, attr)
	}
	req.TimeLimit = searchTimeLimit(c.prof.SearchTimeout)
	c.expireCursors()
	var res *result
	var cursor string
	if c.info.Paging {
		res, cursor, err = c.pagedSearch(ctx, r.Cursor, req)
	} else {
		err = c.read(ctx, func(lc *ldap.Conn) error {
			var err error
			res, err = searchOnce(ctx, lc, req)
			return err
		})
	}
	if err != nil {
		return Page{}, err
	}
	page := Page{Entries: make([]Entry, 0, len(res.entries)), Cursor: cursor, Truncated: res.truncated, Referrals: res.referrals}
	for _, e := range res.entries {
		page.Entries = append(page.Entries, convertEntry(e, s, c.info.ActiveDirectory))
	}
	return page, nil
}

// pagedSearch runs one page on a connection nobody else pages on: the
// first page on the shared connection taken out of its slot, later pages
// on the connection pinned to cursor id. A page with a continuation cookie
// pins its connection under a new cursor ID; the last page releases it and
// a failed page closes it.
func (c *Conn) pagedSearch(ctx context.Context, id string, req *ldap.SearchRequest) (*result, string, error) {
	var res *result
	var lc *ldap.Conn
	var err error
	if id == "" {
		lc, err = retry(ctx, c.take, func(lc *ldap.Conn) error {
			var err error
			res, err = searchOnce(ctx, lc, req)
			return err
		})
		if err != nil {
			if lc != nil {
				// go-ldap sends no Abandon on cancel, so the paged search
				// may still run on lc; never share it again.
				_ = lc.Close()
			}
			return nil, "", err
		}
	} else {
		cur := c.unpin(id)
		if cur == nil {
			return nil, "", ErrCursorExpired
		}
		lc = cur.lc
		if ctl, ok := ldap.FindControl(req.Controls, ldap.ControlTypePaging).(*ldap.ControlPaging); ok {
			ctl.SetCookie(cur.cookie)
		}
		if res, err = searchOnce(ctx, lc, req); err != nil {
			// The server drops the paged state on errors (code 2 or 53
			// for a cookie it no longer knows), so the cursor is done.
			expired := ctx.Err() == nil && (lc.IsClosing() ||
				ldap.IsErrorWithCode(err, ldap.LDAPResultProtocolError) ||
				ldap.IsErrorWithCode(err, ldap.LDAPResultUnwillingToPerform))
			_ = lc.Close()
			if expired {
				return nil, "", fmt.Errorf("%w: %w", ErrCursorExpired, err)
			}
			return nil, "", err
		}
	}
	ctl, ok := ldap.FindControl(res.controls, ldap.ControlTypePaging).(*ldap.ControlPaging)
	if !ok || len(ctl.Cookie) == 0 {
		c.release(lc)
		return res, "", nil
	}
	next, err := c.pin(lc, ctl.Cookie)
	return res, next, err
}

// Entry reads one entry with all user and operational attributes. Ranged
// attributes (large AD groups) are fetched completely.
func (c *Conn) Entry(ctx context.Context, dn string) (Entry, error) {
	e, err := c.rawEntry(ctx, dn, []string{"*", "+"})
	if err != nil {
		return Entry{}, err
	}
	if err := completeRanges(e, c.rangeFetcher(ctx, dn)); err != nil {
		return Entry{}, err
	}
	return convertEntry(e, c.schemaOrEmpty(ctx), c.info.ActiveDirectory), nil
}

func (c *Conn) rawEntry(ctx context.Context, dn string, attrs []string) (*ldap.Entry, error) {
	var res *result
	err := c.read(ctx, func(lc *ldap.Conn) error {
		var err error
		res, err = searchOnce(ctx, lc, &ldap.SearchRequest{
			BaseDN: dn, Scope: ldap.ScopeBaseObject, DerefAliases: ldap.NeverDerefAliases,
			TimeLimit: searchTimeLimit(c.prof.SearchTimeout), Filter: "(objectClass=*)", Attributes: attrs,
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	if len(res.entries) == 0 {
		return nil, ldap.NewError(ldap.LDAPResultNoSuchObject, fmt.Errorf("entry %s not found", dn))
	}
	return res.entries[0], nil
}

func (c *Conn) rangeFetcher(ctx context.Context, dn string) func(string) (*ldap.EntryAttribute, error) {
	return func(attr string) (*ldap.EntryAttribute, error) {
		e, err := c.rawEntry(ctx, dn, []string{attr})
		if err != nil || len(e.Attributes) == 0 {
			return nil, err
		}
		return e.Attributes[0], nil
	}
}

// Schema returns the server schema, reading it on first use.
func (c *Conn) Schema(ctx context.Context) (*schema.Schema, error) {
	c.mu.Lock()
	s := c.schema
	c.mu.Unlock()
	if s != nil {
		return s, nil
	}
	return c.ReloadSchema(ctx)
}

// ReloadSchema reads the schema from the server again.
func (c *Conn) ReloadSchema(ctx context.Context) (*schema.Schema, error) {
	dn := c.info.SubschemaSubentry
	if dn == "" {
		dn = "cn=Subschema"
	}
	e, err := c.rawEntry(ctx, dn, []string{"attributeTypes", "objectClasses", "dITContentRules"})
	if err != nil {
		return nil, fmt.Errorf("read schema %s: %w", dn, err)
	}
	s := schema.Parse(e.GetAttributeValues("attributeTypes"), e.GetAttributeValues("objectClasses"), e.GetAttributeValues("dITContentRules"))
	c.mu.Lock()
	c.schema = s
	c.mu.Unlock()
	return s, nil
}

// schemaOrEmpty returns the schema, or an empty one when it cannot be read
// (for example because the bind DN may not read cn=Subschema). Values are
// then shown without schema hints instead of failing the request.
func (c *Conn) schemaOrEmpty(ctx context.Context) *schema.Schema {
	s, err := c.Schema(ctx)
	if err != nil {
		return schema.Parse(nil, nil, nil)
	}
	return s
}
