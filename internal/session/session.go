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

// Errors returned by Manager.
var (
	ErrNoSession    = errors.New("no such session")
	ErrNotConnected = errors.New("not connected")
)

// Manager maps session IDs to named connections and closes connections of
// sessions that stay idle longer than the configured timeout. It is safe for
// concurrent use. Connections are closed after the internal lock is
// released, so a Close that blocks on the network stalls only its caller.
type Manager[C io.Closer] struct {
	idle time.Duration
	now  func() time.Time

	mu       sync.Mutex
	sessions map[string]*session[C]
}

type session[C io.Closer] struct {
	lastUsed time.Time
	conns    map[string]C
}

// New returns a Manager that expires sessions after idle.
func New[C io.Closer](idle time.Duration) *Manager[C] {
	return &Manager[C]{idle: idle, now: time.Now, sessions: map[string]*session[C]{}}
}

// Create starts an empty session and returns its unguessable ID.
func (m *Manager[C]) Create() string {
	id := rand.Text()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[id] = &session[C]{lastUsed: m.now(), conns: map[string]C{}}
	return id
}

// Exists reports whether id names a live session.
func (m *Manager[C]) Exists(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.sessions[id]
	return ok
}

// Put stores c under name in session id, closing any connection it replaces.
func (m *Manager[C]) Put(id, name string, c C) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return ErrNoSession
	}
	old, replaced := s.conns[name]
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
	s, ok := m.sessions[id]
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
	s, ok := m.sessions[id]
	if !ok {
		return nil
	}
	return slices.Sorted(maps.Keys(s.conns))
}

// Drop closes and forgets one connection.
func (m *Manager[C]) Drop(id, name string) {
	m.mu.Lock()
	s, ok := m.sessions[id]
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

// Sweep closes every session idle for longer than the timeout.
func (m *Manager[C]) Sweep() {
	var expired []C
	m.mu.Lock()
	cutoff := m.now().Add(-m.idle)
	for id, s := range m.sessions {
		if s.lastUsed.Before(cutoff) {
			expired = slices.AppendSeq(expired, maps.Values(s.conns))
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, c := range expired {
		_ = c.Close()
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
