// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package session

import (
	"errors"
	"fmt"
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

// closeSignalSpy is closed by Close, which Sweep runs in the background.
type closeSignalSpy chan struct{}

func (c closeSignalSpy) Close() error {
	close(c)
	return nil
}

func TestSweep(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	m := New[closeSignalSpy](30 * time.Minute)
	m.now = func() time.Time { return now }
	idle, active := m.Create(), m.Create()
	idleConn, activeConn := make(closeSignalSpy), make(closeSignalSpy)
	_ = m.Put(idle, "dev", idleConn)
	_ = m.Put(active, "dev", activeConn)

	now = now.Add(20 * time.Minute)
	_, _ = m.Get(active, "dev")
	now = now.Add(20 * time.Minute)
	m.Sweep()

	select {
	case <-idleConn:
	case <-time.After(time.Second):
		t.Error("Sweep() did not close a session idle for 40m")
	}
	if m.Exists(idle) {
		t.Error("Sweep() kept a session idle for 40m")
	}
	select {
	case <-activeConn:
		t.Error("Sweep() closed a session used 20m ago")
	default:
	}
	if !m.Exists(active) {
		t.Error("Sweep() dropped a session used 20m ago")
	}
}

// blockingCloserStub blocks in Close until release is closed, like a
// connection whose server stopped reading.
type blockingCloserStub struct{ release chan struct{} }

func (c blockingCloserStub) Close() error {
	<-c.release
	return nil
}

// A Close that hangs on a stalled server must not hold up the sweep.
func TestSweepDoesNotWaitForClose(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	m := New[blockingCloserStub](time.Minute)
	m.now = func() time.Time { return now }
	release := make(chan struct{})
	defer close(release)
	id := m.Create()
	_ = m.Put(id, "dev", blockingCloserStub{release: release})
	now = now.Add(time.Hour)

	swept := make(chan struct{})
	go func() {
		m.Sweep()
		close(swept)
	}()
	select {
	case <-swept:
	case <-time.After(time.Second):
		t.Fatal("Sweep() still waiting for a blocked Close after 1s")
	}
	if m.Exists(id) {
		t.Error("Sweep() kept the expired session")
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

func TestRotateMovesConns(t *testing.T) {
	m := New[*closerSpy](time.Hour)
	old := m.Create()
	a, b := &closerSpy{}, &closerSpy{}
	_ = m.Put(old, "a", a)
	_ = m.Put(old, "b", b)

	id := m.Rotate(old)
	if id == old {
		t.Fatalf("Rotate(%q) = the same ID, want a new one", old)
	}
	for name, want := range map[string]*closerSpy{"a": a, "b": b} {
		if got, err := m.Get(id, name); err != nil || got != want {
			t.Errorf("Get(new ID, %s) = %p, %v, want %p", name, got, err, want)
		}
		if want.closed {
			t.Errorf("Rotate() closed connection %s", name)
		}
	}
	if m.Exists(old) {
		t.Error("Exists(old ID) after Rotate = true, want false")
	}
}

func TestRotateUnknown(t *testing.T) {
	m := New[*closerSpy](time.Hour)
	for _, id := range []string{"", "nope"} {
		got := m.Rotate(id)
		if got == id || !m.Exists(got) {
			t.Errorf("Rotate(%q) = %q, want a new live session ID", id, got)
		}
		if names := m.Names(got); len(names) != 0 {
			t.Errorf("Names(Rotate(%q)) = %v, want empty", id, names)
		}
	}
}

func TestPutConnLimit(t *testing.T) {
	m := New[*closerSpy](time.Hour)
	id := m.Create()
	first := &closerSpy{}
	_ = m.Put(id, "c0", first)
	for i := 1; i < MaxConns; i++ {
		if err := m.Put(id, fmt.Sprintf("c%d", i), &closerSpy{}); err != nil {
			t.Fatalf("Put(c%d) error = %v", i, err)
		}
	}
	extra := &closerSpy{}
	if err := m.Put(id, "one-too-many", extra); !errors.Is(err, ErrTooManyConns) {
		t.Errorf("Put() of name %d error = %v, want ErrTooManyConns", MaxConns+1, err)
	}
	if extra.closed {
		t.Error("Put() closed the connection it refused; the caller owns it")
	}
	if err := m.Put(id, "c0", &closerSpy{}); err != nil {
		t.Errorf("Put() over an existing name at the limit error = %v, want nil", err)
	}
	if !first.closed {
		t.Error("Put() over an existing name at the limit did not close the old connection")
	}
	if got := len(m.Names(id)); got != MaxConns {
		t.Errorf("len(Names()) = %d, want %d", got, MaxConns)
	}
}

func TestSessionLimitEvictsOldest(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	m := New[closeSignalSpy](time.Hour)
	m.now = func() time.Time { return now }
	recent := m.Create() // created first, used last
	now = now.Add(time.Second)
	oldest := m.Create()
	oldestConn := make(closeSignalSpy)
	_ = m.Put(oldest, "dev", oldestConn)
	now = now.Add(time.Second)
	for range MaxSessions - 2 {
		m.Create()
	}
	now = now.Add(time.Minute)
	recentConn := make(closeSignalSpy)
	_ = m.Put(recent, "dev", recentConn)

	id := m.Create()

	select {
	case <-oldestConn:
	case <-time.After(time.Second):
		t.Error("Create() over the limit did not close the oldest session's connection")
	}
	if m.Exists(oldest) {
		t.Error("Create() over the limit kept the least recently used session")
	}
	if !m.Exists(recent) || !m.Exists(id) {
		t.Errorf("Exists(most recently used), Exists(new) = %v, %v, want true, true", m.Exists(recent), m.Exists(id))
	}
	select {
	case <-recentConn:
		t.Error("Create() over the limit closed the most recently used session")
	default:
	}
}
