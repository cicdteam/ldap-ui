// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"sync"
	"time"
)

// attemptLimiter counts failed logins per key, a bind DN, and refuses a key
// that failed max times in a window that starts at its first failure, until
// that window ends. It is safe for concurrent use.
//
// ponytail: a check before the dial and a count after it, so concurrent
// connects to one DN each pass blocked before any of them fails: a burst
// gets up to the server's 64 running requests per window instead of max.
// Count in-flight binds in blocked if bursts matter.
type attemptLimiter struct {
	max      int
	window   time.Duration
	capacity int
	now      func() time.Time

	mu      sync.Mutex
	entries map[string]attempts
}

type attempts struct {
	failures int
	start    time.Time // of the first failure in the window
}

// newAttemptLimiter returns a limiter that tracks at most capacity keys.
func newAttemptLimiter(max int, window time.Duration, capacity int, now func() time.Time) *attemptLimiter {
	return &attemptLimiter{max: max, window: window, capacity: capacity, now: now, entries: map[string]attempts{}}
}

// blocked reports whether key is refused, and for how much longer. The
// duration is positive when ok is true.
func (l *attemptLimiter) blocked(key string) (retryAfter time.Duration, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, found := l.entries[key]
	if !found || a.failures < l.max {
		return 0, false
	}
	retryAfter = a.start.Add(l.window).Sub(l.now())
	return retryAfter, retryAfter > 0
}

// fail counts a failed login for key. A new key over capacity drops the
// expired keys, or else the oldest one.
//
// ponytail: an O(capacity) scan per new key once full, cheap next to the
// bind each failure costs; keep keys in start order if capacity grows a lot.
func (l *attemptLimiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	a, found := l.entries[key]
	if found && now.Before(a.start.Add(l.window)) {
		a.failures++
		l.entries[key] = a
		return
	}
	if !found && len(l.entries) >= l.capacity {
		l.prune(now)
	}
	l.entries[key] = attempts{failures: 1, start: now}
}

// prune drops the expired keys, or the oldest one when none has expired.
func (l *attemptLimiter) prune(now time.Time) {
	var oldest string
	var oldestStart time.Time
	for k, a := range l.entries {
		if !now.Before(a.start.Add(l.window)) {
			delete(l.entries, k)
		} else if oldestStart.IsZero() || a.start.Before(oldestStart) {
			oldest, oldestStart = k, a.start
		}
	}
	if len(l.entries) >= l.capacity {
		delete(l.entries, oldest)
	}
}

// succeed forgets key's failures.
func (l *attemptLimiter) succeed(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}
