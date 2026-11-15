// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"fmt"
	"math"

	"github.com/go-ldap/ldap/v3"

	"github.com/cicdteam/ldap-ui/internal/ad"
)

// maxRangeFetches caps the follow-up requests for one ranged attribute, so a
// server that never sends the final chunk cannot keep us looping, even with
// chunks too small for maxAttrValues to end the loop first.
const maxRangeFetches = 10000

// completeRanges replaces Active Directory ranged attributes such as
// "member;range=0-1499" with the full value list, calling fetch for each
// following chunk ("member;range=1500-*"). fetch returns nil when the
// server has nothing more. A chunk that does not start past the previous
// one ends the attribute with the values collected so far. So does holding
// more than maxAttrValues values: convertEntry keeps no more than that and
// marks the attribute truncated.
func completeRanges(e *ldap.Entry, fetch func(attr string) (*ldap.EntryAttribute, error)) error {
	for i, a := range e.Attributes {
		name, _, end, ok := ad.ParseRange(a.Name)
		if !ok {
			continue
		}
		values := a.ByteValues
		for n := 0; end >= 0 && end < math.MaxInt && n < maxRangeFetches && len(values) <= maxAttrValues; n++ {
			more, err := fetch(fmt.Sprintf("%s;range=%d-*", name, end+1))
			if err != nil {
				return err
			}
			if more == nil {
				break
			}
			_, start, next, ranged := ad.ParseRange(more.Name)
			if !ranged || start <= end {
				break
			}
			values = append(values, more.ByteValues...)
			end = next
		}
		strs := make([]string, len(values))
		for j, v := range values {
			strs[j] = string(v)
		}
		e.Attributes[i] = &ldap.EntryAttribute{Name: name, Values: strs, ByteValues: values}
	}
	return nil
}
