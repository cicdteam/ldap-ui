// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"maps"
	"slices"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

// clockFake is a clock that moves only when told to.
type clockFake struct{ t time.Time }

func (c *clockFake) now() time.Time          { return c.t }
func (c *clockFake) advance(d time.Duration) { c.t = c.t.Add(d) }

func newClockFake() *clockFake { return &clockFake{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)} }

func TestLimiterBlocksAfterFive(t *testing.T) {
	clock := newClockFake()
	l := newAttemptLimiter(5, time.Minute, 10, clock.now)
	for i := range 5 {
		if _, ok := l.blocked("uid=a"); ok {
			t.Fatalf("blocked(uid=a) after %d failures = true, want false", i)
		}
		l.fail("uid=a")
		clock.advance(time.Second)
	}
	// The window started at the first failure, 5 s ago.
	if got, ok := l.blocked("uid=a"); !ok || got != 55*time.Second {
		t.Errorf("blocked(uid=a) after 5 failures = %v, %v, want 55s, true", got, ok)
	}
	clock.advance(56 * time.Second) // 61 s after the first failure
	if got, ok := l.blocked("uid=a"); ok {
		t.Errorf("blocked(uid=a) after the window = %v, true, want false", got)
	}
}

func TestLimiterSuccessResets(t *testing.T) {
	l := newAttemptLimiter(5, time.Minute, 10, newClockFake().now)
	for range 4 {
		l.fail("uid=a")
	}
	l.succeed("uid=a")
	for range 4 {
		l.fail("uid=a")
	}
	if got, ok := l.blocked("uid=a"); ok {
		t.Errorf("blocked(uid=a) after 4 failures, a success and 4 failures = %v, true, want false", got)
	}
}

func TestLimiterKeysIndependent(t *testing.T) {
	l := newAttemptLimiter(5, time.Minute, 10, newClockFake().now)
	for range 5 {
		l.fail("uid=a")
	}
	if _, ok := l.blocked("uid=a"); !ok {
		t.Errorf("blocked(uid=a) after 5 failures = false, want true")
	}
	if got, ok := l.blocked("uid=b"); ok {
		t.Errorf("blocked(uid=b) after 5 failures of uid=a = %v, true, want false", got)
	}
}

func TestLimiterCapacity(t *testing.T) {
	keys := func(l *attemptLimiter) []string { return slices.Sorted(maps.Keys(l.entries)) }

	t.Run("all live", func(t *testing.T) {
		clock := newClockFake()
		l := newAttemptLimiter(5, time.Minute, 3, clock.now)
		for _, k := range []string{"uid=1", "uid=2", "uid=3", "uid=4"} {
			l.fail(k)
			clock.advance(time.Second)
		}
		if diff := cmp.Diff([]string{"uid=2", "uid=3", "uid=4"}, keys(l)); diff != "" {
			t.Errorf("keys tracked with capacity 3 mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("expired pruned first", func(t *testing.T) {
		clock := newClockFake()
		l := newAttemptLimiter(5, time.Minute, 3, clock.now)
		l.fail("uid=1")
		l.fail("uid=2")
		clock.advance(30 * time.Second)
		l.fail("uid=3")
		clock.advance(31 * time.Second) // uid=1 and uid=2 have expired
		l.fail("uid=4")
		if diff := cmp.Diff([]string{"uid=3", "uid=4"}, keys(l)); diff != "" {
			t.Errorf("keys tracked with capacity 3 and 2 expired mismatch (-want +got):\n%s", diff)
		}
	})
}
