// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

// Package session keeps per-browser LDAP connections in memory.
//
// Sessions live only in this process, so a deployment needs one replica or
// sticky sessions.
package session

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"maps"
	"slices"
	"sync"
	"time"
)

// Limits on what one process holds.
const (
	// MaxSessions bounds the live sessions: a new one past it evicts the
	// least recently used.
	MaxSessions = 1000
	// MaxConns bounds the connections of one session.
	MaxConns = 8
)

// Errors returned by Manager.
var (
	ErrNoSession    = errors.New("no such session")
	ErrNotConnected = errors.New("not connected")
	ErrTooManyConns = errors.New("too many connections in this session")
)

// Manager maps session IDs to named connections and closes connections of
// sessions that stay idle longer than the idle timeout or live longer than
// the maximum age. It is safe for concurrent use. Connections are closed
// after the internal lock is released, so a Close that blocks on the network
// stalls only its caller.
type Manager[C io.Closer] struct {
	idle   time.Duration
	maxAge time.Duration
	now    func() time.Time

	mu       sync.Mutex
	sessions map[string]*session[C]
}

type session[C io.Closer] struct {
	created  time.Time // set at Rotate
	lastUsed time.Time
	conns    map[string]C
}

// New returns a Manager that expires sessions after idle without use, and
// maxAge after they were created or last rotated, however active.
func New[C io.Closer](idle, maxAge time.Duration) *Manager[C] {
	return &Manager[C]{idle: idle, maxAge: maxAge, now: time.Now, sessions: map[string]*session[C]{}}
}

// live returns session id unless it is past maxAge. Callers hold m.mu. A
// session past maxAge counts as missing everywhere and stays in the map, its
// connections open, until Sweep closes them.
//
// ponytail: up to a minute of open connections past maxAge, with Run's
// ticker; close them right here in the background if that matters.
func (m *Manager[C]) live(id string) (*session[C], bool) {
	s, ok := m.sessions[id]
	if !ok || m.tooOld(s, m.now()) {
		return nil, false
	}
	return s, true
}

func (m *Manager[C]) tooOld(s *session[C], now time.Time) bool {
	return now.Sub(s.created) > m.maxAge
}

// Create starts an empty session and returns its unguessable ID. At
// MaxSessions it first evicts the least recently used session, as Rotate
// does.
func (m *Manager[C]) Create() string { return m.Rotate("") }

// Rotate moves the connections of session id, when it exists, to a new
// session and returns the new unguessable ID; id stops naming a session.
// The new session's maximum age starts now: a connect is a new sign-in. An
// unknown, empty or too old id gives a new empty session. Adding a session at
// MaxSessions evicts the least recently used one, closing its connections
// in the background as Sweep does.
//
// ponytail: a request still carrying id after Rotate, from another tab at
// the same instant, finds it gone: that tab reconnects, and if it was
// connecting too, one tab's connections are lost. Keep id as a short-lived
// alias of the new ID if that bites.
func (m *Manager[C]) Rotate(id string) string {
	newID := rand.Text()
	var evicted []C
	m.mu.Lock()
	s, ok := m.live(id)
	if ok {
		delete(m.sessions, id)
	} else {
		s = &session[C]{conns: map[string]C{}}
	}
	if len(m.sessions) >= MaxSessions {
		// ponytail: linear scan at the cap, cheap at MaxSessions; keep the
		// sessions in a list ordered by use if the cap grows.
		var oldest string
		for k, v := range m.sessions {
			if oldest == "" || v.lastUsed.Before(m.sessions[oldest].lastUsed) {
				oldest = k
			}
		}
		evicted = slices.Collect(maps.Values(m.sessions[oldest].conns))
		delete(m.sessions, oldest)
	}
	s.created = m.now()
	s.lastUsed = s.created
	m.sessions[newID] = s
	m.mu.Unlock()
	closeInBackground(evicted)
	return newID
}

// Exists reports whether id names a live session.
func (m *Manager[C]) Exists(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.live(id)
	return ok
}

// Put stores c under name in session id, closing any connection it
// replaces. It returns ErrTooManyConns, leaving c open, when name is new and
// the session already holds MaxConns connections.
func (m *Manager[C]) Put(id, name string, c C) error {
	m.mu.Lock()
	s, ok := m.live(id)
	if !ok {
		m.mu.Unlock()
		return ErrNoSession
	}
	old, replaced := s.conns[name]
	if !replaced && len(s.conns) >= MaxConns {
		m.mu.Unlock()
		return ErrTooManyConns
	}
	s.conns[name] = c
	s.lastUsed = m.now()
	m.mu.Unlock()
	if replaced {
		_ = old.Close()
	}
	return nil
}

// Get returns the connection stored under name and marks the session used.
func (m *Manager[C]) Get(id, name string) (C, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var zero C
	s, ok := m.live(id)
	if !ok {
		return zero, ErrNoSession
	}
	c, ok := s.conns[name]
	if !ok {
		return zero, ErrNotConnected
	}
	s.lastUsed = m.now()
	return c, nil
}

// Names returns the sorted connection names of session id.
func (m *Manager[C]) Names(id string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.live(id)
	if !ok {
		return nil
	}
	return slices.Sorted(maps.Keys(s.conns))
}

// Drop closes and forgets one connection.
func (m *Manager[C]) Drop(id, name string) {
	m.mu.Lock()
	s, ok := m.live(id)
	if !ok {
		m.mu.Unlock()
		return
	}
	c, found := s.conns[name]
	delete(s.conns, name)
	m.mu.Unlock()
	if found {
		_ = c.Close()
	}
}

// Sweep closes every session idle for longer than the timeout or older than
// the maximum age. Each connection closes in a goroutine of its own and
// Sweep does not wait for it: a Close stuck on a stalled server must not
// hold up the sweeper.
func (m *Manager[C]) Sweep() {
	var expired []C
	m.mu.Lock()
	now := m.now()
	cutoff := now.Add(-m.idle)
	for id, s := range m.sessions {
		if s.lastUsed.Before(cutoff) || m.tooOld(s, now) {
			expired = slices.AppendSeq(expired, maps.Values(s.conns))
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	closeInBackground(expired)
}

// closeInBackground closes each connection in a goroutine of its own and
// does not wait for it.
func closeInBackground[C io.Closer](conns []C) {
	for _, c := range conns {
		go func() { _ = c.Close() }()
	}
}

// Run calls Sweep every minute until ctx is done.
func (m *Manager[C]) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.Sweep()
		}
	}
}
