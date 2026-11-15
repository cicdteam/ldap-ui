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

// Manager maps session IDs to named connections. It closes the
// connections of sessions that stay idle longer than the idle timeout, and
// each connection older than the maximum age, however active. It is safe
// for concurrent use. Connections are closed after the internal lock is
// released, so a Close that blocks on the network stalls only its caller.
type Manager[C io.Closer] struct {
	idle   time.Duration
	maxAge time.Duration
	now    func() time.Time

	mu       sync.Mutex
	sessions map[string]*session[C]
}

type session[C io.Closer] struct {
	lastUsed time.Time
	conns    map[string]entry[C]
}

// entry is a stored connection with the time of its Put, from which its
// maximum age counts.
type entry[C io.Closer] struct {
	c   C
	put time.Time
}

// New returns a Manager that expires sessions after idle without use, and
// each connection maxAge after it was put, however active.
func New[C io.Closer](idle, maxAge time.Duration) *Manager[C] {
	return &Manager[C]{idle: idle, maxAge: maxAge, now: time.Now, sessions: map[string]*session[C]{}}
}

// tooOld reports whether e is past the maximum age. Such a connection counts
// as missing: Get and Names skip it, Rotate moves it with its age, and it
// stays open until Sweep closes it.
//
// ponytail: up to a minute of open connections past maxAge, with Run's
// ticker, and they count against MaxConns until then; close them in the
// background where they are found if that matters.
func (m *Manager[C]) tooOld(e entry[C], now time.Time) bool {
	return now.Sub(e.put) > m.maxAge
}

// Create starts an empty session and returns its unguessable ID. At
// MaxSessions it first evicts the least recently used session, as Rotate
// does.
func (m *Manager[C]) Create() string { return m.Rotate("") }

// Rotate moves the connections of session id, when it exists, to a new
// session and returns the new unguessable ID; id stops naming a session.
// The connections keep their age. An unknown or empty id gives a new empty
// session. Adding a session at MaxSessions evicts the least recently used
// one, closing its connections in the background as Sweep does.
//
// ponytail: a request still carrying id after Rotate, from another tab at
// the same instant, finds it gone: that tab reconnects, and if it was
// connecting too, one tab's connections are lost. Keep id as a short-lived
// alias of the new ID if that bites.
func (m *Manager[C]) Rotate(id string) string {
	newID := rand.Text()
	var evicted []C
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	} else {
		s = &session[C]{conns: map[string]entry[C]{}}
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
		for _, e := range m.sessions[oldest].conns {
			evicted = append(evicted, e.c)
		}
		delete(m.sessions, oldest)
	}
	s.lastUsed = m.now()
	m.sessions[newID] = s
	m.mu.Unlock()
	closeInBackground(evicted)
	return newID
}

// Exists reports whether id names a live session.
func (m *Manager[C]) Exists(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.sessions[id]
	return ok
}

// Put stores c under name in session id, closing any connection it
// replaces; c's maximum age starts now. It returns ErrTooManyConns, leaving
// c open, when name is new and the session already holds MaxConns
// connections.
func (m *Manager[C]) Put(id, name string, c C) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return ErrNoSession
	}
	old, replaced := s.conns[name]
	if !replaced && len(s.conns) >= MaxConns {
		m.mu.Unlock()
		return ErrTooManyConns
	}
	now := m.now()
	s.conns[name] = entry[C]{c: c, put: now}
	s.lastUsed = now
	m.mu.Unlock()
	if replaced {
		_ = old.c.Close()
	}
	return nil
}

// Get returns the connection stored under name and marks the session used.
// A connection past the maximum age gives ErrNotConnected.
func (m *Manager[C]) Get(id, name string) (C, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var zero C
	s, ok := m.sessions[id]
	if !ok {
		return zero, ErrNoSession
	}
	now := m.now()
	e, ok := s.conns[name]
	if !ok || m.tooOld(e, now) {
		return zero, ErrNotConnected
	}
	s.lastUsed = now
	return e.c, nil
}

// Names returns the sorted names of the connections of session id that are
// within the maximum age.
func (m *Manager[C]) Names(id string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil
	}
	now := m.now()
	var names []string
	for name, e := range s.conns {
		if !m.tooOld(e, now) {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names
}

// Drop closes and forgets one connection.
func (m *Manager[C]) Drop(id, name string) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return
	}
	e, found := s.conns[name]
	delete(s.conns, name)
	m.mu.Unlock()
	if found {
		_ = e.c.Close()
	}
}

// Sweep closes every session idle for longer than the timeout and every
// connection older than the maximum age, and forgets a session that this
// leaves without connections. Each connection closes in a goroutine of its
// own and Sweep does not wait for it: a Close stuck on a stalled server must
// not hold up the sweeper.
func (m *Manager[C]) Sweep() {
	var expired []C
	m.mu.Lock()
	now := m.now()
	cutoff := now.Add(-m.idle)
	for id, s := range m.sessions {
		idle := s.lastUsed.Before(cutoff)
		closed := false
		for name, e := range s.conns {
			if idle || m.tooOld(e, now) {
				expired = append(expired, e.c)
				delete(s.conns, name)
				closed = true
			}
		}
		if idle || (closed && len(s.conns) == 0) {
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
