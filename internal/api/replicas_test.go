// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package api

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/google/go-cmp/cmp"

	"github.com/cicdteam/ldaplens/internal/ldapx"
	"github.com/cicdteam/ldaplens/internal/profile"
	"github.com/cicdteam/ldaplens/internal/session"
)

// replica is another ldaplens process behind the same load balancer as e:
// the same catalog, its own sessions and shared connections, and a browser
// holding e's cookies. It dials with dial, or with e's dialer when dial is
// nil.
func (e *testEnv) replica(dial Dialer) *testEnv {
	o := e.opts
	o.Sessions = session.New[Directory](time.Hour, 8*time.Hour)
	o.Shared = session.New[Directory](time.Hour, 8*time.Hour)
	if dial != nil {
		o.Dial = dial
	}
	return &testEnv{h: New(o), dir: e.dir, opts: o, cookies: slices.Clone(e.cookies)}
}

func TestTwoReplicasSharedProfile(t *testing.T) {
	a := newTestEnv(t)
	connectTo(t, a, `{"profile":"dev"}`)
	b := a.replica(nil) // a's dialer, so a.dials counts b's dials too
	if diff := cmp.Diff([]string(nil), connectedNames(t, b)); diff != "" {
		t.Errorf("connected profiles on B before a request mismatch (-want +got):\n%s", diff)
	}
	if rec := b.do(t, http.MethodPost, "/api/c/dev/search", `{"filter":"(cn=x)"}`); rec.Code != http.StatusOK {
		t.Errorf("search on B = %d %s, want 200", rec.Code, rec.Body)
	}
	if rec := b.do(t, http.MethodGet, "/api/c/dev/entry?dn=cn%3Dx", ""); rec.Code != http.StatusOK {
		t.Errorf("entry on B = %d %s, want 200", rec.Code, rec.Body)
	}
	if a.dials != 2 || a.password != "from-env" {
		t.Errorf("dials, last password = %d, %q, want 2 (one on A, one on B), the configured one", a.dials, a.password)
	}
	if diff := cmp.Diff([]string{"dev"}, connectedNames(t, b)); diff != "" {
		t.Errorf("connected profiles on B mismatch (-want +got):\n%s", diff)
	}
	other := &testEnv{h: a.h} // another browser on A
	if diff := cmp.Diff([]string{"dev"}, connectedNames(t, other)); diff != "" {
		t.Errorf("connected profiles for another browser on A mismatch (-want +got):\n%s", diff)
	}

	// Two first requests at once on a replica that has not dialed yet: one
	// dials, the other waits for it and uses its connection.
	synctest.Test(t, func(t *testing.T) {
		var dials atomic.Int32
		release := make(chan struct{})
		c := a.replica(func(context.Context, profile.Profile, string) (Directory, error) {
			dials.Add(1)
			<-release
			return &directoryFake{info: ldapx.Info{BaseDN: "dc=example,dc=org"}}, nil
		})
		var wg sync.WaitGroup
		codes := make([]int, 2)
		for i := range codes {
			wg.Go(func() { codes[i] = c.do(t, http.MethodGet, "/api/c/dev/info", "").Code })
		}
		synctest.Wait()
		close(release)
		wg.Wait()
		if got := dials.Load(); got != 1 {
			t.Errorf("dials for two concurrent first requests = %d, want 1", got)
		}
		if diff := cmp.Diff([]int{http.StatusOK, http.StatusOK}, codes); diff != "" {
			t.Errorf("concurrent info statuses mismatch (-want +got):\n%s", diff)
		}
	})
}

func TestTwoReplicasTypedPassword(t *testing.T) {
	a := newTestEnv(t)
	connectTo(t, a, `{"profile":"manual","password":"typed"}`)
	b := a.replica(nil)
	if rec := b.do(t, http.MethodGet, "/api/c/manual/info", ""); rec.Code != http.StatusUnauthorized || errorCode(t, rec) != "not_connected" {
		t.Errorf("info on B = %d %s, want 401 not_connected", rec.Code, rec.Body)
	}
	if a.dials != 1 {
		t.Errorf("dials = %d, want 1: B must not dial a typed-password profile", a.dials)
	}
	other := &testEnv{h: a.h} // another browser on A, without the cookie
	if rec := other.do(t, http.MethodGet, "/api/c/manual/info", ""); rec.Code != http.StatusUnauthorized || errorCode(t, rec) != "not_connected" {
		t.Errorf("info from another browser on A = %d %s, want 401 not_connected", rec.Code, rec.Body)
	}
}

// TestSharedTypedPassword checks that a password typed for a shared
// profile, as after its configured one failed, connects that browser only:
// another browser gets the configured password.
func TestSharedTypedPassword(t *testing.T) {
	env := newTestEnv(t)
	connectTo(t, env, `{"profile":"dev","password":"typed"}`)
	if env.cookie(sessionCookie) == "" || env.password != "typed" {
		t.Errorf("connect with a typed password: session cookie %q, dial password %q, want a cookie and the typed one", env.cookie(sessionCookie), env.password)
	}
	other := &testEnv{h: env.h}
	if rec := other.do(t, http.MethodGet, "/api/c/dev/info", ""); rec.Code != http.StatusOK {
		t.Errorf("info from another browser = %d %s, want 200", rec.Code, rec.Body)
	}
	if env.dials != 2 || env.password != "from-env" {
		t.Errorf("dials, last password = %d, %q, want 2, the configured one", env.dials, env.password)
	}
}

func TestSharedConnectNoSessionCookie(t *testing.T) {
	var logs bytes.Buffer
	env := newTestEnvWith(t, Options{Logger: slog.New(slog.NewJSONHandler(&logs, nil))})
	rec := env.do(t, http.MethodPost, "/api/connect", `{"profile":"dev"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("connect = %d %s, want 200", rec.Code, rec.Body)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie {
			t.Errorf("connect to a shared profile set cookie %s", c.Name)
		}
	}
	got := withMsg(jsonLogs(t, &logs), "connected")
	if len(got) != 1 || got[0]["profile"] != "dev" || got[0]["bindDN"] != "cn=admin,dc=example,dc=org" {
		t.Errorf("connected lines = %v, want one with profile dev and bindDN cn=admin,dc=example,dc=org", got)
	}
}

func TestSharedDisconnect(t *testing.T) {
	env := connected(t)
	if rec := env.do(t, http.MethodPost, "/api/disconnect", `{"profile":"dev"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("disconnect = %d %s, want 204", rec.Code, rec.Body)
	}
	if env.dir.closed {
		t.Error("disconnect closed the shared connection")
	}
	if rec := env.do(t, http.MethodPost, "/api/c/dev/search", `{"filter":"(cn=x)"}`); rec.Code != http.StatusOK {
		t.Errorf("search after disconnect = %d %s, want 200", rec.Code, rec.Body)
	}
	if env.dials != 1 {
		t.Errorf("dials = %d, want 1", env.dials)
	}
}

// TestSharedWritesGuarded checks that writes through a shared connection,
// here dialed by the write itself on another replica, pass the same checks
// as any other.
func TestSharedWritesGuarded(t *testing.T) {
	a := newTestEnv(t)
	if rec := a.do(t, http.MethodPost, "/api/profiles", `{"name":"ro","url":"ldap://ro:389","readOnly":true}`); rec.Code != http.StatusOK {
		t.Fatalf("save = %d %s, want 200", rec.Code, rec.Body)
	}
	b := a.replica(nil)
	if rec := b.do(t, http.MethodPost, "/api/c/ro/entries/delete", deleteBody); rec.Code != http.StatusForbidden || errorCode(t, rec) != "read_only" {
		t.Errorf("delete on a read-only shared profile = %d %s, want 403 read_only", rec.Code, rec.Body)
	}
	if rec := b.do(t, http.MethodPost, "/api/c/prodrw/entries/delete", deleteBody); rec.Code != http.StatusConflict || errorCode(t, rec) != "confirmation_required" {
		t.Errorf("delete on prod without confirm = %d %s, want 409 confirmation_required", rec.Code, rec.Body)
	}
	if len(a.dir.writes) != 0 {
		t.Errorf("writes = %q, want none", a.dir.writes)
	}
	if rec := b.do(t, http.MethodPost, "/api/c/prodrw/entries/delete", `{"dn":"uid=n,dc=example,dc=org","confirm":"prodrw"}`); rec.Code != http.StatusOK {
		t.Errorf("delete on prod with confirm = %d %s, want 200", rec.Code, rec.Body)
	}
}

// TestSharedRedialsClosed checks that a shared connection closed for good,
// as ldapx closes one whose reconnect the server refused the password of,
// is dialed again, with the configured password read anew: by a connect,
// and by the next request. Until then the profiles list shows it
// disconnected.
func TestSharedRedialsClosed(t *testing.T) {
	env := connected(t)
	for i, redial := range []func(){
		func() { connectTo(t, env, `{"profile":"dev"}`) },
		func() { env.do(t, http.MethodPost, "/api/c/dev/search", `{"filter":"(cn=x)"}`) },
	} {
		env.dir.closed = true
		env.dir = &directoryFake{info: ldapx.Info{BaseDN: "dc=example,dc=org"}}
		pw := fmt.Sprintf("rotated-%d", i)
		t.Setenv("LDAPLENS_TEST_PW", pw)
		if diff := cmp.Diff([]string(nil), connectedNames(t, env)); diff != "" {
			t.Errorf("%d: connected profiles with a closed connection mismatch (-want +got):\n%s", i, diff)
		}
		redial()
		if want := i + 2; env.dials != want || env.password != pw {
			t.Errorf("%d: dials, last password = %d, %q, want %d, %q", i, env.dials, env.password, want, pw)
		}
		if rec := env.do(t, http.MethodPost, "/api/c/dev/search", `{"filter":"(cn=x)"}`); rec.Code != http.StatusOK {
			t.Errorf("%d: search after the redial = %d %s, want 200", i, rec.Code, rec.Body)
		}
		if diff := cmp.Diff([]string{"dev"}, connectedNames(t, env)); diff != "" {
			t.Errorf("%d: connected profiles after the redial mismatch (-want +got):\n%s", i, diff)
		}
	}
	if env.dials != 3 {
		t.Errorf("dials = %d, want 3", env.dials)
	}
}

// TestSharedSaveRedials checks that saving a profile drops its shared
// connection, so the next request dials the saved settings.
func TestSharedSaveRedials(t *testing.T) {
	env := newTestEnv(t)
	for _, url := range []string{"ldap://lab:389", "ldap://lab2:389"} {
		if rec := env.do(t, http.MethodPost, "/api/profiles", `{"name":"lab","url":"`+url+`"}`); rec.Code != http.StatusOK {
			t.Fatalf("save %s = %d %s, want 200", url, rec.Code, rec.Body)
		}
		connectTo(t, env, `{"profile":"lab"}`)
		if env.dialed.URL != url {
			t.Errorf("connect after saving %s dialed %q", url, env.dialed.URL)
		}
	}
	if env.dials != 2 {
		t.Errorf("dials = %d, want 2", env.dials)
	}
}
