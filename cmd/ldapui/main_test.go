// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func TestParseFlags(t *testing.T) {
	env := map[string]string{
		"LDAPUI_LISTEN":        "0.0.0.0:9000",
		"LDAPUI_ALLOWED_HOSTS": "ldap.example.com, ui.local,",
		"LDAPUI_DATA_DIR":      "/data",
	}
	getenv := func(k string) string { return env[k] }

	got, err := parseFlags([]string{"--base-path", "/ldap/"}, getenv, io.Discard)
	if err != nil {
		t.Fatalf("parseFlags() error = %v", err)
	}
	want := config{
		listen: "0.0.0.0:9000", basePath: "/ldap", dataDir: "/data",
		allowedHosts: []string{"ldap.example.com", "ui.local"}, sessionIdle: 30 * time.Minute,
	}
	if diff := cmp.Diff(want, got, cmp.AllowUnexported(config{})); diff != "" {
		t.Errorf("parseFlags() mismatch (-want +got):\n%s", diff)
	}

	got, err = parseFlags([]string{"--listen", "127.0.0.1:1"}, getenv, io.Discard)
	if err != nil || got.listen != "127.0.0.1:1" {
		t.Errorf("parseFlags(--listen) = %q, %v, want the flag to win over env", got.listen, err)
	}

	for _, bad := range []string{"ldap", "/a b", "/ldap/<x>"} {
		if _, err := parseFlags([]string{"--base-path", bad}, getenv, io.Discard); err == nil {
			t.Errorf("parseFlags(--base-path %q) error = nil, want error", bad)
		}
	}
}

func TestParseFlagsSecureCookies(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		env     string
		want    bool
		wantErr bool
	}{
		{name: "default", want: false},
		{name: "env", env: "true", want: true},
		{name: "flag", args: []string{"--secure-cookies"}, want: true},
		{name: "flag wins over env", args: []string{"--secure-cookies=false"}, env: "1", want: false},
		{name: "invalid env", env: "maybe", wantErr: true},
	}
	for _, tc := range tests {
		getenv := func(k string) string {
			if k == "LDAPUI_SECURE_COOKIES" {
				return tc.env
			}
			return ""
		}
		got, err := parseFlags(tc.args, getenv, io.Discard)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: parseFlags(%q) error = nil, want error", tc.name, tc.args)
			}
			continue
		}
		if err != nil || got.secureCookies != tc.want {
			t.Errorf("%s: parseFlags(%q) secureCookies = %v, %v, want %v, nil", tc.name, tc.args, got.secureCookies, err, tc.want)
		}
	}
}

func TestParseFlagsSessionIdle(t *testing.T) {
	tests := []struct {
		value   string
		want    time.Duration
		wantErr bool
	}{
		{value: "5m", want: 5 * time.Minute},
		{value: "0", wantErr: true},
		{value: "-1m", wantErr: true},
	}
	noEnv := func(string) string { return "" }
	for _, tc := range tests {
		got, err := parseFlags([]string{"--session-idle", tc.value}, noEnv, io.Discard)
		if tc.wantErr {
			if err == nil {
				t.Errorf("parseFlags(--session-idle %s) error = nil, want error", tc.value)
			}
			continue
		}
		if err != nil || got.sessionIdle != tc.want {
			t.Errorf("parseFlags(--session-idle %s) = %v, %v, want %v, nil", tc.value, got.sessionIdle, err, tc.want)
		}
	}
}

// clearEnv blanks every LDAPUI_* variable for the rest of t, so a test of
// run does not read the developer's environment; empty counts as unset.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); strings.HasPrefix(k, "LDAPUI_") {
			t.Setenv(k, "")
		}
	}
}

// TestRunHelp checks that -h succeeds after printing usage, as it would
// with flag.ExitOnError, instead of failing with flag.ErrHelp.
func TestRunHelp(t *testing.T) {
	clearEnv(t)
	if err := run([]string{"-h"}); err != nil {
		t.Errorf("run(-h) = %v, want nil", err)
	}
}

// TestRunVersion checks that --version prints the version and stops, even
// when the LDAPUI_* environment would fail validation.
func TestRunVersion(t *testing.T) {
	tests := []struct {
		name, key, value string
	}{
		{name: "clean env"},
		{name: "bad listen", key: "LDAPUI_LISTEN", value: "bad"},
		{name: "bad secure cookies", key: "LDAPUI_SECURE_COOKIES", value: "maybe"},
		{name: "bad base path", key: "LDAPUI_BASE_PATH", value: "ldap"},
		{name: "short auth token", key: "LDAPUI_AUTH_TOKEN", value: "short"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearEnv(t)
			if tc.key != "" {
				t.Setenv(tc.key, tc.value)
			}
			var out bytes.Buffer
			if err := runTo([]string{"--version"}, &out); err != nil {
				t.Fatalf("run(--version) with %s=%q = %v, want nil", tc.key, tc.value, err)
			}
			if got, want := out.String(), "ldapui dev\n"; got != want {
				t.Errorf("run(--version) with %s=%q printed %q, want %q", tc.key, tc.value, got, want)
			}
		})
	}
}

func TestParseFlagsAuthToken(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		wantErr bool
	}{
		{name: "unset"},
		{name: "valid", value: "abcXYZ0129._~-ok"},
		{name: "generated", value: rand.Text()},
		{name: "too short", value: "abcXYZ0129._~-o", wantErr: true},
		{name: "bad char", value: "abcXYZ0129._~-ok;", wantErr: true},
		{name: "space", value: "abcXYZ0129 ._~-ok", wantErr: true},
	}
	noEnv := func(string) string { return "" }
	for _, tc := range tests {
		got, err := parseFlags([]string{"--auth-token", tc.value}, noEnv, io.Discard)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: parseFlags(--auth-token %q) error = nil, want error", tc.name, tc.value)
			}
			continue
		}
		if err != nil || got.authToken != tc.value {
			t.Errorf("%s: parseFlags(--auth-token %q) = %q, %v, want %q, nil", tc.name, tc.value, got.authToken, err, tc.value)
		}
	}

	envShort := func(k string) string {
		if k == "LDAPUI_AUTH_TOKEN" {
			return "short"
		}
		return ""
	}
	if _, err := parseFlags(nil, envShort, io.Discard); err == nil {
		t.Errorf("parseFlags() with LDAPUI_AUTH_TOKEN=short error = nil, want error")
	}
}

func TestParseFlagsKeepsEnvTokenOutOfUsage(t *testing.T) {
	const fromEnv = "SuperSecretToken1234"
	getenv := func(k string) string {
		if k == "LDAPUI_AUTH_TOKEN" {
			return fromEnv
		}
		return ""
	}
	for _, args := range [][]string{{"--bogus"}, {"-h"}} {
		var usage bytes.Buffer
		if _, err := parseFlags(args, getenv, &usage); err == nil {
			t.Errorf("parseFlags(%q) error = nil, want error", args)
		}
		if strings.Contains(usage.String(), fromEnv) {
			t.Errorf("parseFlags(%q) usage output contains the env auth token:\n%s", args, usage.String())
		}
	}
	got, err := parseFlags(nil, getenv, io.Discard)
	if err != nil || got.authToken != fromEnv {
		t.Errorf("parseFlags() authToken = %q, %v, want %q from LDAPUI_AUTH_TOKEN", got.authToken, err, fromEnv)
	}
}

func TestServeDrainsInFlightRequests(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var finished atomic.Bool
	srv := &http.Server{
		Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			close(entered)
			<-release
			finished.Store(true)
		}),
		ReadHeaderTimeout: time.Second,
	}
	shuttingDown := make(chan struct{})
	srv.RegisterOnShutdown(func() { close(shuttingDown) })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	served := make(chan error, 1)
	go func() { served <- serve(ctx, srv, ln) }()

	requested := make(chan struct{})
	go func() {
		defer close(requested)
		resp, err := http.Get("http://" + ln.Addr().String() + "/")
		if err != nil {
			t.Errorf("GET in-flight request error = %v", err)
			return
		}
		_ = resp.Body.Close()
	}()
	<-entered
	cancel()
	<-shuttingDown
	// The listener is closed now, so srv.Serve returns; serve must still wait
	// for the in-flight handler.
	time.AfterFunc(50*time.Millisecond, func() { close(release) })
	if err := <-served; err != nil {
		t.Errorf("serve() = %v, want nil", err)
	}
	if !finished.Load() {
		t.Errorf("serve() returned before the in-flight request finished")
	}
	<-requested
}

func TestIsLoopback(t *testing.T) {
	tests := map[string]bool{
		"127.0.0.1:8080": true,
		"localhost:8080": true,
		"[::1]:8080":     true,
		"0.0.0.0:8080":   false,
		":8080":          false,
		"10.0.0.5:8080":  false,
		"garbage":        false,
	}
	for addr, want := range tests {
		if got := isLoopback(addr); got != want {
			t.Errorf("isLoopback(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestLoginURL(t *testing.T) {
	if got, want := loginURL("[::]:8080", "/ldap", "a b"), "http://localhost:8080/ldap/?token=a+b"; got != want {
		t.Errorf("loginURL() = %q, want %q", got, want)
	}
}
