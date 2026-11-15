// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"sync"
	"time"
)

// attemptLimiter counts failed logins per key, a bind DN, together with the
// logins in flight, so that a key never has more than max of them in a
// window that starts at its first failure. It is safe for concurrent use.
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
	inflight int       // logins begun and not yet ended
}

// newAttemptLimiter returns a limiter that tracks at most capacity keys,
// beyond those with logins in flight.
func newAttemptLimiter(max int, window time.Duration, capacity int, now func() time.Time) *attemptLimiter {
	return &attemptLimiter{max: max, window: window, capacity: capacity, now: now, entries: map[string]attempts{}}
}

// begin starts a login as key, or refuses it while key's failures in the
// window and its logins in flight reach max. A refusal says how long to
// wait: until the window ends, or 1 s when only logins in flight fill it.
// Each begin that returns ok must be followed by exactly one fail, succeed
// or done.
func (l *attemptLimiter) begin(key string) (retryAfter time.Duration, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	a, found := l.entries[key]
	if a.failures > 0 && !now.Before(a.start.Add(l.window)) {
		a.failures = 0 // the window is over
	}
	if a.failures+a.inflight >= l.max {
		if a.failures == 0 {
			return time.Second, false
		}
		return a.start.Add(l.window).Sub(now), false
	}
	if !found && len(l.entries) >= l.capacity {
		l.prune(now)
	}
	a.inflight++
	l.entries[key] = a
	return 0, true
}

// fail ends a login as key that failed for a wrong password.
func (l *attemptLimiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	a := l.release(key)
	if a.failures == 0 || !now.Before(a.start.Add(l.window)) {
		a.failures, a.start = 0, now
	}
	a.failures++
	l.entries[key] = a
}

// succeed ends a login as key that succeeded, forgetting key's failures.
func (l *attemptLimiter) succeed(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a := l.release(key)
	a.failures = 0
	l.store(key, a)
}

// done ends a login as key that failed for another reason, such as a
// server that cannot be reached; it does not count.
func (l *attemptLimiter) done(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.store(key, l.release(key))
}

// release is key's entry with one login fewer in flight. l.mu must be held.
func (l *attemptLimiter) release(key string) attempts {
	a := l.entries[key]
	if a.inflight > 0 {
		a.inflight--
	}
	return a
}

// store keeps a as key's entry, or drops the entry when a has nothing left
// to count. l.mu must be held.
func (l *attemptLimiter) store(key string, a attempts) {
	if a.failures == 0 && a.inflight == 0 {
		delete(l.entries, key)
		return
	}
	l.entries[key] = a
}

// prune drops the keys whose window is over, or else the one whose window
// started first. It never drops a key with logins in flight: when every key
// has some, the limiter goes over capacity by at most the server's running
// requests. l.mu must be held.
//
// ponytail: an O(capacity) scan per new key once full, cheap next to the
// bind each login costs; keep keys in start order if capacity grows a lot.
func (l *attemptLimiter) prune(now time.Time) {
	var oldest string
	var oldestStart time.Time
	for k, a := range l.entries {
		switch {
		case a.inflight > 0:
		case !now.Before(a.start.Add(l.window)):
			delete(l.entries, k)
		case oldestStart.IsZero() || a.start.Before(oldestStart):
			oldest, oldestStart = k, a.start
		}
	}
	if len(l.entries) >= l.capacity && !oldestStart.IsZero() {
		delete(l.entries, oldest)
	}
}
