// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package ldapx

import (
	"fmt"
	"math"
	"strconv"
	"testing"

	"github.com/go-ldap/ldap/v3"
	"github.com/google/go-cmp/cmp"

	"github.com/cicdteam/ldaplens/internal/schema"
)

func attr(name string, values ...string) *ldap.EntryAttribute {
	a := &ldap.EntryAttribute{Name: name, Values: values}
	for _, v := range values {
		a.ByteValues = append(a.ByteValues, []byte(v))
	}
	return a
}

func TestCompleteRanges(t *testing.T) {
	chunks := map[string]*ldap.EntryAttribute{
		"member;range=2-*": attr("member;range=2-3", "c", "d"),
		"member;range=4-*": attr("member;range=4-*", "e"),
	}
	var asked []string
	fetch := func(a string) (*ldap.EntryAttribute, error) {
		asked = append(asked, a)
		return chunks[a], nil
	}
	e := &ldap.Entry{DN: "cn=big", Attributes: []*ldap.EntryAttribute{attr("cn", "big"), attr("member;range=0-1", "a", "b")}}
	if err := completeRanges(e, fetch); err != nil {
		t.Fatalf("completeRanges() error = %v", err)
	}
	if diff := cmp.Diff([]string{"member;range=2-*", "member;range=4-*"}, asked); diff != "" {
		t.Errorf("fetched ranges mismatch (-want +got):\n%s", diff)
	}
	want := []*ldap.EntryAttribute{attr("cn", "big"), attr("member", "a", "b", "c", "d", "e")}
	if diff := cmp.Diff(want, e.Attributes); diff != "" {
		t.Errorf("completeRanges() attributes mismatch (-want +got):\n%s", diff)
	}
}

// TestCompleteRangesTerminates covers servers that never send the final
// "*" chunk: completeRanges must stop instead of looping forever.
func TestCompleteRangesTerminates(t *testing.T) {
	tests := []struct {
		name        string
		first       *ldap.EntryAttribute
		chunk       func(n int) *ldap.EntryAttribute // n-th follow-up, from 1
		wantFetches int
		wantValues  int
	}{
		{
			name:        "repeats the same range",
			first:       attr("member;range=0-1", "a", "b"),
			chunk:       func(int) *ldap.EntryAttribute { return attr("member;range=0-1", "a", "b") },
			wantFetches: 1,
			wantValues:  2,
		},
		{
			name:        "end at max int",
			first:       attr(fmt.Sprintf("member;range=0-%d", math.MaxInt), "a"),
			wantFetches: 0,
			wantValues:  1,
		},
		{
			name:  "endless advancing ranges",
			first: attr("member;range=0-0", "a"),
			chunk: func(n int) *ldap.EntryAttribute {
				return attr(fmt.Sprintf("member;range=%d-%d", n, n), "x")
			},
			wantFetches: maxRangeFetches,
			wantValues:  1 + maxRangeFetches,
		},
	}
	for _, tc := range tests {
		fetches := 0
		fetch := func(string) (*ldap.EntryAttribute, error) {
			fetches++
			return tc.chunk(fetches), nil
		}
		e := &ldap.Entry{DN: "cn=big", Attributes: []*ldap.EntryAttribute{tc.first}}
		if err := completeRanges(e, fetch); err != nil {
			t.Errorf("%s: completeRanges() error = %v", tc.name, err)
			continue
		}
		if fetches != tc.wantFetches {
			t.Errorf("%s: completeRanges() fetched %d chunks, want %d", tc.name, fetches, tc.wantFetches)
		}
		got := e.Attributes[0]
		if got.Name != "member" || len(got.ByteValues) != tc.wantValues {
			t.Errorf("%s: completeRanges() = %q with %d values, want %q with %d", tc.name, got.Name, len(got.ByteValues), "member", tc.wantValues)
		}
	}
}

// TestCompleteRangesStopsPastMaxAttrValues checks that range retrieval stops
// once it holds more values than an entry carries, and that the attribute
// then converts as truncated.
func TestCompleteRangesStopsPastMaxAttrValues(t *testing.T) {
	// Ten chunks of 1500 values; the last one ends the range.
	chunk := func(n int) *ldap.EntryAttribute {
		start, end := n*1500, strconv.Itoa(n*1500+1499)
		if n == 9 {
			end = "*"
		}
		a := &ldap.EntryAttribute{Name: fmt.Sprintf("member;range=%d-%s", start, end)}
		for i := range 1500 {
			a.ByteValues = append(a.ByteValues, []byte(strconv.Itoa(start+i)))
		}
		return a
	}
	fetches := 0
	fetch := func(string) (*ldap.EntryAttribute, error) {
		fetches++
		return chunk(fetches), nil
	}
	e := &ldap.Entry{DN: "cn=big", Attributes: []*ldap.EntryAttribute{chunk(0)}}
	if err := completeRanges(e, fetch); err != nil {
		t.Fatalf("completeRanges() error = %v", err)
	}
	// Seven chunks hold 10 500 values, the first count past maxAttrValues.
	if got := len(e.Attributes[0].ByteValues); fetches != 6 || got != 10500 {
		t.Errorf("completeRanges() fetched %d chunks, %d values; want 6, 10500", fetches, got)
	}
	a := convertEntry(e, schema.Parse(nil, nil, nil), false).Attributes[0]
	if a.Name != "member" || len(a.Values) != maxAttrValues || !a.Truncated {
		t.Errorf("convertEntry() = %q with %d values, truncated %v; want %q with %d, truncated", a.Name, len(a.Values), a.Truncated, "member", maxAttrValues)
	}
}
