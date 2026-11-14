// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package session

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

type closerSpy struct{ closed bool }

func (c *closerSpy) Close() error {
	c.closed = true
	return nil
}

func TestPutGet(t *testing.T) {
	m := New[*closerSpy](time.Hour)
	id := m.Create()
	first, second := &closerSpy{}, &closerSpy{}
	if err := m.Put(id, "dev", first); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if err := m.Put(id, "dev", second); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if !first.closed {
		t.Error("Put() over an existing name did not close the old connection")
	}
	if got, err := m.Get(id, "dev"); err != nil || got != second {
		t.Errorf("Get(dev) = %p, %v, want %p", got, err, second)
	}
	if _, err := m.Get(id, "prod"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Get(prod) error = %v, want ErrNotConnected", err)
	}
	if _, err := m.Get("nope", "dev"); !errors.Is(err, ErrNoSession) {
		t.Errorf("Get(unknown session) error = %v, want ErrNoSession", err)
	}
	if err := m.Put("nope", "dev", &closerSpy{}); !errors.Is(err, ErrNoSession) {
		t.Errorf("Put(unknown session) error = %v, want ErrNoSession", err)
	}
}

func TestNamesAndDrop(t *testing.T) {
	m := New[*closerSpy](time.Hour)
	id := m.Create()
	b := &closerSpy{}
	_ = m.Put(id, "b", b)
	_ = m.Put(id, "a", &closerSpy{})
	if diff := cmp.Diff([]string{"a", "b"}, m.Names(id)); diff != "" {
		t.Errorf("Names() mismatch (-want +got):\n%s", diff)
	}
	m.Drop(id, "b")
	if !b.closed {
		t.Error("Drop(b) did not close the connection")
	}
	if diff := cmp.Diff([]string{"a"}, m.Names(id)); diff != "" {
		t.Errorf("Names() after Drop mismatch (-want +got):\n%s", diff)
	}
	if got := m.Names("nope"); len(got) != 0 {
		t.Errorf("Names(unknown) = %v, want empty", got)
	}
}

func TestSweep(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	m := New[*closerSpy](30 * time.Minute)
	m.now = func() time.Time { return now }
	idle, active := m.Create(), m.Create()
	idleConn, activeConn := &closerSpy{}, &closerSpy{}
	_ = m.Put(idle, "dev", idleConn)
	_ = m.Put(active, "dev", activeConn)

	now = now.Add(20 * time.Minute)
	_, _ = m.Get(active, "dev")
	now = now.Add(20 * time.Minute)
	m.Sweep()

	if !idleConn.closed || m.Exists(idle) {
		t.Error("Sweep() kept a session idle for 40m")
	}
	if activeConn.closed || !m.Exists(active) {
		t.Error("Sweep() closed a session used 20m ago")
	}
}

func TestCreateUnique(t *testing.T) {
	m := New[*closerSpy](time.Hour)
	if a, b := m.Create(), m.Create(); a == b || len(a) < 20 {
		t.Errorf("Create() = %q, %q, want distinct random IDs", a, b)
	}
}

// lockSpy records whether the manager mutex was held when Close ran.
type lockSpy struct {
	mu     *sync.Mutex
	locked bool
}

func (c *lockSpy) Close() error {
	if c.mu.TryLock() {
		c.mu.Unlock()
	} else {
		c.locked = true
	}
	return nil
}

// A Close that blocks on the network must not stall every other session.
func TestCloseOutsideLock(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	m := New[*lockSpy](time.Minute)
	m.now = func() time.Time { return now }
	id := m.Create()
	replaced, dropped, swept := &lockSpy{mu: &m.mu}, &lockSpy{mu: &m.mu}, &lockSpy{mu: &m.mu}
	_ = m.Put(id, "a", replaced)
	_ = m.Put(id, "a", &lockSpy{mu: &m.mu})
	_ = m.Put(id, "b", dropped)
	m.Drop(id, "b")
	_ = m.Put(id, "c", swept)
	now = now.Add(time.Hour)
	m.Sweep()

	for name, c := range map[string]*lockSpy{"Put": replaced, "Drop": dropped, "Sweep": swept} {
		if c.locked {
			t.Errorf("%s() closed a connection while holding the manager lock", name)
		}
	}
}
