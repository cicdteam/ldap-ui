// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"maps"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

// clockFake is a clock that moves only when told to.
type clockFake struct{ t time.Time }

func (c *clockFake) now() time.Time          { return c.t }
func (c *clockFake) advance(d time.Duration) { c.t = c.t.Add(d) }

func newClockFake() *clockFake { return &clockFake{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)} }

// failN begins and fails n logins as key.
func failN(t *testing.T, l *attemptLimiter, key string, n int) {
	t.Helper()
	for i := range n {
		if wait, ok := l.begin(key); !ok {
			t.Fatalf("begin(%s) after %d failures = %v, false, want true", key, i, wait)
		}
		l.fail(key)
	}
}

func TestLimiterBlocksAfterFive(t *testing.T) {
	clock := newClockFake()
	l := newAttemptLimiter(5, time.Minute, 10, clock.now)
	for range 5 {
		failN(t, l, "uid=a", 1)
		clock.advance(time.Second)
	}
	// The window started at the first failure, 5 s ago.
	if got, ok := l.begin("uid=a"); ok || got != 55*time.Second {
		t.Errorf("begin(uid=a) after 5 failures = %v, %v, want 55s, false", got, ok)
	}
	clock.advance(56 * time.Second) // 61 s after the first failure
	if got, ok := l.begin("uid=a"); !ok {
		t.Errorf("begin(uid=a) after the window = %v, false, want true", got)
	}
}

func TestLimiterSuccessResets(t *testing.T) {
	l := newAttemptLimiter(5, time.Minute, 10, newClockFake().now)
	failN(t, l, "uid=a", 4)
	l.begin("uid=a")
	l.succeed("uid=a")
	failN(t, l, "uid=a", 4)
	if got, ok := l.begin("uid=a"); !ok {
		t.Errorf("begin(uid=a) after 4 failures, a success and 4 failures = %v, false, want true", got)
	}
}

func TestLimiterKeysIndependent(t *testing.T) {
	l := newAttemptLimiter(5, time.Minute, 10, newClockFake().now)
	failN(t, l, "uid=a", 5)
	if _, ok := l.begin("uid=a"); ok {
		t.Errorf("begin(uid=a) after 5 failures = true, want false")
	}
	if got, ok := l.begin("uid=b"); !ok {
		t.Errorf("begin(uid=b) after 5 failures of uid=a = %v, false, want true", got)
	}
}

func TestLimiterConcurrentBurst(t *testing.T) {
	l := newAttemptLimiter(5, time.Minute, 10, newClockFake().now)
	start := make(chan struct{})
	var begun atomic.Int32
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			<-start
			if _, ok := l.begin("uid=a"); ok {
				begun.Add(1)
				l.fail("uid=a")
			}
		})
	}
	close(start)
	wg.Wait()
	if got := begun.Load(); got > 5 {
		t.Errorf("20 concurrent begin(uid=a): %d ok, want at most 5", got)
	}
	if _, ok := l.begin("uid=a"); ok {
		t.Errorf("begin(uid=a) after the burst failed = true, want false")
	}
}

// TestLimiterInFlight checks that logins in flight count against the limit
// and that done gives back their slot without counting.
func TestLimiterInFlight(t *testing.T) {
	l := newAttemptLimiter(5, time.Minute, 10, newClockFake().now)
	for i := range 5 {
		if _, ok := l.begin("uid=a"); !ok {
			t.Fatalf("begin(uid=a) with %d in flight = false, want true", i)
		}
	}
	if got, ok := l.begin("uid=a"); ok || got != time.Second {
		t.Errorf("begin(uid=a) with 5 in flight = %v, %v, want 1s, false", got, ok)
	}
	l.done("uid=a")
	if got, ok := l.begin("uid=a"); !ok {
		t.Errorf("begin(uid=a) after done = %v, false, want true", got)
	}
	for range 5 {
		l.done("uid=a")
	}
	if len(l.entries) != 0 {
		t.Errorf("entries after every login is done = %v, want none", l.entries)
	}
}

func TestLimiterCapacity(t *testing.T) {
	keys := func(l *attemptLimiter) []string { return slices.Sorted(maps.Keys(l.entries)) }

	t.Run("all live", func(t *testing.T) {
		clock := newClockFake()
		l := newAttemptLimiter(5, time.Minute, 3, clock.now)
		for _, k := range []string{"uid=1", "uid=2", "uid=3", "uid=4"} {
			failN(t, l, k, 1)
			clock.advance(time.Second)
		}
		if diff := cmp.Diff([]string{"uid=2", "uid=3", "uid=4"}, keys(l)); diff != "" {
			t.Errorf("keys tracked with capacity 3 mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("expired pruned first", func(t *testing.T) {
		clock := newClockFake()
		l := newAttemptLimiter(5, time.Minute, 3, clock.now)
		failN(t, l, "uid=1", 1)
		failN(t, l, "uid=2", 1)
		clock.advance(30 * time.Second)
		failN(t, l, "uid=3", 1)
		clock.advance(31 * time.Second) // uid=1 and uid=2 have expired
		failN(t, l, "uid=4", 1)
		if diff := cmp.Diff([]string{"uid=3", "uid=4"}, keys(l)); diff != "" {
			t.Errorf("keys tracked with capacity 3 and 2 expired mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("in flight kept", func(t *testing.T) {
		clock := newClockFake()
		l := newAttemptLimiter(5, time.Minute, 2, clock.now)
		l.begin("uid=1") // never ends
		clock.advance(time.Second)
		failN(t, l, "uid=2", 1)
		clock.advance(time.Second)
		failN(t, l, "uid=3", 1)
		if diff := cmp.Diff([]string{"uid=1", "uid=3"}, keys(l)); diff != "" {
			t.Errorf("keys tracked with capacity 2 and uid=1 in flight mismatch (-want +got):\n%s", diff)
		}
	})
}
