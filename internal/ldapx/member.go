// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-ldap/ldap/v3"
)

// Ref is one group membership. Via names the group through which the
// membership is inherited and is empty for direct membership.
type Ref struct {
	DN  string `json:"dn"`
	Via string `json:"via,omitempty"`
}

// Membership is the answer to a membership query. Truncated is set when a
// server limit or one of ldaplens's caps cut a scan short, so Refs may be
// incomplete. Refs is never nil, so JSON clients get [] rather than null.
type Membership struct {
	Refs      []Ref `json:"refs"`
	Truncated bool  `json:"truncated,omitempty"`
}

const (
	maxNestingDepth = 10
	// ponytail: hard cap on returned memberships; add paging to the
	// membership API if someone needs more than this on one screen.
	maxRefs = 10000
	// maxGroupIndex caps the group list Members(nested) uses to recognize
	// member groups. Scans fetch DNs only, so it can be much larger than
	// maxRefs.
	maxGroupIndex = 200000
)

const groupFilter = "(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=group))"

// MemberOf returns the groups under the base DN that list dn as member or
// uniqueMember, and the posixGroups whose memberUid holds one of dn's uid
// values. With nested set it follows groups that are members of groups, up
// to maxNestingDepth levels (groups left past that mark the result
// truncated), and survives membership cycles; memberUid names users, not
// groups, so only the first level asks for it.
func (c *Conn) MemberOf(ctx context.Context, dn string, nested bool) (Membership, error) {
	e, err := c.rawEntry(ctx, dn, []string{"uid"})
	if err != nil {
		return Membership{}, err
	}
	uids := e.GetEqualFoldAttributeValues("uid")
	m := Membership{Refs: []Ref{}}
	seen := map[string]bool{normDN(dn): true}
	frontier := []string{dn}
	for depth := 0; len(frontier) > 0; depth++ {
		if depth == maxNestingDepth {
			m.Truncated = true // the groups in frontier are not followed
			break
		}
		var next []string
		for _, member := range frontier {
			escaped := ldap.EscapeFilter(member)
			filter := fmt.Sprintf("(member=%s)(uniqueMember=%s)", escaped, escaped)
			if depth == 0 {
				for _, u := range uids {
					filter += fmt.Sprintf("(memberUid=%s)", ldap.EscapeFilter(u))
				}
			}
			groups, truncated, err := c.allDNs(ctx, "(|"+filter+")", maxRefs)
			if err != nil {
				return Membership{}, err
			}
			m.Truncated = m.Truncated || truncated
			for _, g := range groups {
				if seen[normDN(g)] {
					continue
				}
				if len(m.Refs) == maxRefs {
					m.Truncated = true
					return m, nil
				}
				seen[normDN(g)] = true
				m.Refs = append(m.Refs, Ref{DN: g, Via: viaFor(depth, member)})
				next = append(next, g)
			}
		}
		if !nested {
			break
		}
		if len(m.Refs) >= maxRefs {
			m.Truncated = m.Truncated || len(next) > 0 // groups of next are not followed
			break
		}
		frontier = next
	}
	return m, nil
}

// Members returns the member and uniqueMember values of group dn. With
// nested set, members of member groups are included too, up to
// maxNestingDepth levels (groups left past that mark the result truncated).
func (c *Conn) Members(ctx context.Context, dn string, nested bool) (Membership, error) {
	m := Membership{Refs: []Ref{}}
	isGroup := map[string]bool{}
	if nested {
		groups, truncated, err := c.allDNs(ctx, groupFilter, maxGroupIndex)
		if err != nil {
			return Membership{}, err
		}
		// Member groups missing from the index are not followed.
		m.Truncated = truncated
		for _, g := range groups {
			isGroup[normDN(g)] = true
		}
	}
	seen := map[string]bool{normDN(dn): true}
	frontier := []string{dn}
	for depth := 0; len(frontier) > 0; depth++ {
		if depth == maxNestingDepth || len(m.Refs) >= maxRefs {
			m.Truncated = true // the groups in frontier are not read
			break
		}
		var next []string
		for _, group := range frontier {
			members, err := c.memberValues(ctx, group)
			if err != nil {
				return Membership{}, err
			}
			for _, member := range members {
				if seen[normDN(member)] {
					continue
				}
				if len(m.Refs) == maxRefs {
					m.Truncated = true
					return m, nil
				}
				seen[normDN(member)] = true
				m.Refs = append(m.Refs, Ref{DN: member, Via: viaFor(depth, group)})
				if isGroup[normDN(member)] {
					next = append(next, member)
				}
			}
		}
		frontier = next
	}
	return m, nil
}

func viaFor(depth int, through string) string {
	if depth == 0 {
		return ""
	}
	return through
}

func (c *Conn) memberValues(ctx context.Context, dn string) ([]string, error) {
	e, err := c.rawEntry(ctx, dn, []string{"member", "uniqueMember"})
	if err != nil {
		return nil, err
	}
	if err := completeRanges(e, c.rangeFetcher(ctx, dn)); err != nil {
		return nil, err
	}
	var out []string
	for _, a := range e.Attributes {
		out = append(out, a.Values...)
	}
	return out, nil
}

// allDNs returns the DNs of the entries under the base DN that match
// filter, at most limit of them. truncated is set when a server limit, the
// limit argument or, without paging, maxResponseEntries cut the scan short.
// It walks the pages like Search (see walk), 1000 at a time.
// ponytail: Members(nested) lists every group under the base DN to know
// which members are groups, so member groups beyond the first
// maxGroupIndex (200000) groups are not followed (the result is marked
// truncated); switch to a per-DN objectClass lookup if a directory has
// more groups than that.
func (c *Conn) allDNs(ctx context.Context, filter string, limit int) (dns []string, truncated bool, err error) {
	req := &ldap.SearchRequest{
		BaseDN: c.info.BaseDN, Scope: ldap.ScopeWholeSubtree, DerefAliases: ldap.NeverDerefAliases,
		TimeLimit: searchTimeLimit(c.prof.SearchTimeout), Filter: filter, Attributes: []string{"1.1"},
	}
	if c.info.Paging {
		req.Controls = []ldap.Control{ldap.NewControlPaging(1000)}
	} else {
		req.SizeLimit = limit
	}
	res, err := c.walk(ctx, req, limit)
	if err != nil {
		return nil, false, err
	}
	for _, e := range res.entries {
		dns = append(dns, e.DN)
	}
	return dns, res.truncated || res.more, nil
}

// normDN returns a comparison key for dn.
func normDN(dn string) string {
	if d, err := ldap.ParseDN(dn); err == nil {
		return strings.ToLower(d.String())
	}
	return strings.ToLower(dn)
}
