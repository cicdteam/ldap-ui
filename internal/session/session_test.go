// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package session

import (
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

// exists reports whether id names a live session of m.
func exists[C io.Closer](m *Manager[C], id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.sessions[id]
	return ok
}

type closerSpy struct{ closed bool }

func (c *closerSpy) Close() error {
	c.closed = true
	return nil
}

func TestPutGet(t *testing.T) {
	m := New[*closerSpy](time.Hour, 8*time.Hour)
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
	m := New[*closerSpy](time.Hour, 8*time.Hour)
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

func TestDropConn(t *testing.T) {
	m := New[*closerSpy](time.Hour, 8*time.Hour)
	id := m.Create()
	old, cur := &closerSpy{}, &closerSpy{}
	_ = m.Put(id, "dev", old)
	_ = m.Put(id, "dev", cur)
	m.DropConn(id, "dev", old) // replaced meanwhile: cur must stay
	if got, err := m.Get(id, "dev"); err != nil || got != cur || cur.closed {
		t.Errorf("after DropConn(old): Get(dev) = %p, %v, closed %v, want %p open", got, err, cur.closed, cur)
	}
	m.DropConn(id, "dev", cur)
	if _, err := m.Get(id, "dev"); !errors.Is(err, ErrNotConnected) || !cur.closed {
		t.Errorf("after DropConn(cur): Get(dev) error = %v, closed %v, want ErrNotConnected, closed", err, cur.closed)
	}
	m.DropConn("nope", "dev", cur) // unknown session: no panic
}

func TestConns(t *testing.T) {
	now := time.Unix(0, 0)
	m := New[*closerSpy](time.Hour, 2*time.Hour)
	m.now = func() time.Time { return now }
	id := m.Create()
	a, b := &closerSpy{}, &closerSpy{}
	_ = m.Put(id, "a", a)
	now = now.Add(90 * time.Minute)
	_ = m.Put(id, "b", b)
	now = now.Add(40 * time.Minute) // a is past the maximum age, b is not
	if got := m.Conns(id); len(got) != 1 || got["b"] != b {
		t.Errorf("Conns() = %v, want only b %p", got, b)
	}
	now = now.Add(30 * time.Minute) // idle since the Put, not since Conns
	m.Sweep()
	if exists(m, id) {
		t.Error("Conns() marked the session used: Sweep kept it")
	}
	if got := m.Conns("nope"); len(got) != 0 {
		t.Errorf("Conns(unknown) = %v, want empty", got)
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
	m := New[closeSignalSpy](30*time.Minute, 8*time.Hour)
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
	if exists(m, idle) {
		t.Error("Sweep() kept a session idle for 40m")
	}
	select {
	case <-activeConn:
		t.Error("Sweep() closed a session used 20m ago")
	default:
	}
	if !exists(m, active) {
		t.Error("Sweep() dropped a session used 20m ago")
	}
}

// A connection in use every minute still ends 8h after it was put, and its
// session goes with it once nothing is left.
func TestMaxAgeExpires(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	m := New[closeSignalSpy](30*time.Minute, 8*time.Hour)
	m.now = func() time.Time { return now }
	id := m.Create()
	conn := make(closeSignalSpy)
	_ = m.Put(id, "dev", conn)

	for elapsed := time.Minute; elapsed <= 8*time.Hour; elapsed += time.Minute {
		now = now.Add(time.Minute)
		if _, err := m.Get(id, "dev"); err != nil {
			t.Fatalf("Get() %v after Put error = %v, want nil", elapsed, err)
		}
	}
	now = now.Add(time.Minute)

	if _, err := m.Get(id, "dev"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Get() 8h1m after Put error = %v, want ErrNotConnected", err)
	}
	if names := m.Names(id); len(names) != 0 {
		t.Errorf("Names() 8h1m after Put = %v, want empty", names)
	}
	id = m.Rotate(id)
	if _, err := m.Get(id, "dev"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Get(Rotate()) 8h1m after Put error = %v, want ErrNotConnected: rotation must not revive the connection", err)
	}
	m.Sweep()
	select {
	case <-conn:
	case <-time.After(time.Second):
		t.Error("Sweep() did not close a connection 8h1m after Put")
	}
	if _, err := m.Get(id, "dev"); !errors.Is(err, ErrNoSession) {
		t.Errorf("Get() after Sweep error = %v, want ErrNoSession for a session left with no connections", err)
	}
}

// Rotation moves connections with their age: it is not a new sign-in for
// the connections it carries.
func TestRotateKeepsConnAge(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	m := New[closeSignalSpy](24*time.Hour, 8*time.Hour)
	m.now = func() time.Time { return now }
	old := m.Create()
	conn := make(closeSignalSpy)
	_ = m.Put(old, "dev", conn)
	now = now.Add(7 * time.Hour)
	id := m.Rotate(old)

	now = now.Add(time.Hour + time.Minute)
	if _, err := m.Get(id, "dev"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Get() 8h1m after Put, rotated at 7h, error = %v, want ErrNotConnected", err)
	}
	m.Sweep()
	select {
	case <-conn:
	case <-time.After(time.Second):
		t.Error("Sweep() did not close a connection 8h1m after Put, rotated at 7h")
	}
}

// Each connection counts its own age from its own Put.
func TestConnAgeIndependent(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	m := New[closeSignalSpy](24*time.Hour, 8*time.Hour)
	m.now = func() time.Time { return now }
	id := m.Create()
	a, b := make(closeSignalSpy), make(closeSignalSpy)
	_ = m.Put(id, "a", a)
	now = now.Add(4 * time.Hour)
	_ = m.Put(id, "b", b)
	now = now.Add(4*time.Hour + time.Minute)

	if _, err := m.Get(id, "a"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Get(a) 8h1m after its Put error = %v, want ErrNotConnected", err)
	}
	if got, err := m.Get(id, "b"); err != nil || got != b {
		t.Errorf("Get(b) 4h1m after its Put = %v, %v, want b, nil", got, err)
	}
	if diff := cmp.Diff([]string{"b"}, m.Names(id)); diff != "" {
		t.Errorf("Names() mismatch (-want +got):\n%s", diff)
	}
	m.Sweep()
	select {
	case <-a:
	case <-time.After(time.Second):
		t.Error("Sweep() did not close a connection 8h1m after its Put")
	}
	select {
	case <-b:
		t.Error("Sweep() closed a connection 4h1m after its Put")
	default:
	}
	if got, err := m.Get(id, "b"); err != nil || got != b {
		t.Errorf("Get(b) after Sweep = %v, %v, want b, nil", got, err)
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
	m := New[blockingCloserStub](time.Minute, 8*time.Hour)
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
	if exists(m, id) {
		t.Error("Sweep() kept the expired session")
	}
}

func TestCreateUnique(t *testing.T) {
	m := New[*closerSpy](time.Hour, 8*time.Hour)
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
	m := New[*lockSpy](time.Minute, 8*time.Hour)
	id := m.Create()
	replaced, dropped := &lockSpy{mu: &m.mu}, &lockSpy{mu: &m.mu}
	_ = m.Put(id, "a", replaced)
	_ = m.Put(id, "a", &lockSpy{mu: &m.mu})
	_ = m.Put(id, "b", dropped)
	m.Drop(id, "b")

	for name, c := range map[string]*lockSpy{"Put": replaced, "Drop": dropped} {
		if c.locked {
			t.Errorf("%s() closed a connection while holding the manager lock", name)
		}
	}
}

func TestRotateMovesConns(t *testing.T) {
	m := New[*closerSpy](time.Hour, 8*time.Hour)
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
	if exists(m, old) {
		t.Error("exists(old ID) after Rotate = true, want false")
	}
}

func TestRotateUnknown(t *testing.T) {
	m := New[*closerSpy](time.Hour, 8*time.Hour)
	for _, id := range []string{"", "nope"} {
		got := m.Rotate(id)
		if got == id || !exists(m, got) {
			t.Errorf("Rotate(%q) = %q, want a new live session ID", id, got)
		}
		if names := m.Names(got); len(names) != 0 {
			t.Errorf("Names(Rotate(%q)) = %v, want empty", id, names)
		}
	}
}

func TestPutConnLimit(t *testing.T) {
	m := New[*closerSpy](time.Hour, 8*time.Hour)
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
	m := New[closeSignalSpy](time.Hour, 8*time.Hour)
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
	if exists(m, oldest) {
		t.Error("Create() over the limit kept the least recently used session")
	}
	if !exists(m, recent) || !exists(m, id) {
		t.Errorf("exists(most recently used), exists(new) = %v, %v, want true, true", exists(m, recent), exists(m, id))
	}
	select {
	case <-recentConn:
		t.Error("Create() over the limit closed the most recently used session")
	default:
	}
}
