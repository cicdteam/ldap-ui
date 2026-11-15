// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"

	"github.com/cicdteam/ldap-ui/internal/profile"
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
		{name: "missing auth token file", key: "LDAPUI_AUTH_TOKEN_FILE", value: "/nonexistent/token"},
		{name: "bad session idle", key: "LDAPUI_SESSION_IDLE", value: "soon"},
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

func TestParseFlagsIdentity(t *testing.T) {
	env := map[string]string{"LDAPUI_TRUSTED_PROXIES": "10.0.0.0/8, 192.0.2.7,,2001:db8::1"}
	getenv := func(k string) string { return env[k] }
	got, err := parseFlags([]string{"--identity-header", "X-Auth-Request-Email"}, getenv, io.Discard)
	if err != nil {
		t.Fatalf("parseFlags(--identity-header) error = %v", err)
	}
	if got.identityHeader != "X-Auth-Request-Email" {
		t.Errorf("parseFlags(--identity-header) identityHeader = %q, want X-Auth-Request-Email", got.identityHeader)
	}
	want := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("192.0.2.7/32"),
		netip.MustParsePrefix("2001:db8::1/128"),
	}
	if diff := cmp.Diff(want, got.trustedProxies, cmp.Comparer(func(a, b netip.Prefix) bool { return a == b })); diff != "" {
		t.Errorf("parseFlags() trustedProxies mismatch (-want +got):\n%s", diff)
	}

	noEnv := func(string) string { return "" }
	if _, err := parseFlags([]string{"--identity-header", "X-Auth-Request-Email"}, noEnv, io.Discard); err == nil {
		t.Errorf("parseFlags(--identity-header without --trusted-proxies) error = nil, want error")
	}
	args := []string{"--identity-header", "X-Auth-Request-Email", "--trusted-proxies", "10.0.0.0/8,10.0.0.0/99"}
	if _, err := parseFlags(args, noEnv, io.Discard); err == nil || !strings.Contains(err.Error(), "10.0.0.0/99") {
		t.Errorf("parseFlags(%q) error = %v, want an error naming 10.0.0.0/99", args, err)
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
	go func() { served <- serve(ctx, srv, ln, drainTimeout, slog.New(slog.DiscardHandler)) }()

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

func TestParseFlagsTokenFile(t *testing.T) {
	const token = "abcXYZ0129._~-ok" //nolint:gosec // test value, not a credential
	dir := t.TempDir()
	write := func(name, content string) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("os.WriteFile(%q) error = %v", path, err)
		}
		return path
	}
	lf := write("token-lf", token+"\n")
	crlf := write("token-crlf", token+"\r\n")
	twoLF := write("token-two-lf", token+"\n\n")
	tiny := write("tiny", "abc123\n")
	missing := filepath.Join(dir, "missing")

	tests := []struct {
		name    string
		args    []string
		env     map[string]string
		want    string
		wantErr string // a substring of the error; empty wants no error
	}{
		{name: "flag", args: []string{"--auth-token-file", lf}, want: token},
		{name: "env", env: map[string]string{"LDAPUI_AUTH_TOKEN_FILE": crlf}, want: token},
		{name: "flag beats env token", args: []string{"--auth-token-file", lf}, env: map[string]string{"LDAPUI_AUTH_TOKEN": "otherTokenFromEnv1"}, want: token},
		{name: "both flags", args: []string{"--auth-token", token, "--auth-token-file", lf}, wantErr: "--auth-token-file"},
		{name: "both env", env: map[string]string{"LDAPUI_AUTH_TOKEN": token, "LDAPUI_AUTH_TOKEN_FILE": lf}, wantErr: "LDAPUI_AUTH_TOKEN_FILE"},
		{name: "missing file", args: []string{"--auth-token-file", missing}, wantErr: missing},
		{name: "short token", args: []string{"--auth-token-file", tiny}, wantErr: tiny},
		{name: "only one newline trimmed", args: []string{"--auth-token-file", twoLF}, wantErr: twoLF},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(k string) string { return tc.env[k] }
			got, err := parseFlags(tc.args, getenv, io.Discard)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("parseFlags(%q) error = %v, want an error naming %q", tc.args, err, tc.wantErr)
				}
				if strings.Contains(err.Error(), "abc123") {
					t.Errorf("parseFlags(%q) error = %v, want it not to echo the token", tc.args, err)
				}
				return
			}
			if err != nil || got.authToken != tc.want {
				t.Errorf("parseFlags(%q) authToken = %q, %v, want %q, nil", tc.args, got.authToken, err, tc.want)
			}
		})
	}
}

func TestParseFlagsSessionIdleEnv(t *testing.T) {
	env := map[string]string{"LDAPUI_SESSION_IDLE": "5m"}
	getenv := func(k string) string { return env[k] }
	if got, err := parseFlags(nil, getenv, io.Discard); err != nil || got.sessionIdle != 5*time.Minute {
		t.Errorf("parseFlags() with LDAPUI_SESSION_IDLE=5m sessionIdle = %v, %v, want 5m, nil", got.sessionIdle, err)
	}
	args := []string{"--session-idle", "1m"}
	if got, err := parseFlags(args, getenv, io.Discard); err != nil || got.sessionIdle != time.Minute {
		t.Errorf("parseFlags(%q) with LDAPUI_SESSION_IDLE=5m sessionIdle = %v, %v, want 1m, nil", args, got.sessionIdle, err)
	}
	env["LDAPUI_SESSION_IDLE"] = "soon"
	if _, err := parseFlags(nil, getenv, io.Discard); err == nil {
		t.Errorf("parseFlags() with LDAPUI_SESSION_IDLE=soon error = nil, want error")
	}
}

func TestServeDrainTimeout(t *testing.T) {
	t.Run("blocked handler", func(t *testing.T) {
		entered, release := make(chan struct{}), make(chan struct{})
		defer close(release)
		srv := &http.Server{
			Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				close(entered)
				<-release
			}),
			ReadHeaderTimeout: time.Second,
		}
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("net.Listen() error = %v", err)
		}
		var logs bytes.Buffer
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		served := make(chan error, 1)
		go func() { served <- serve(ctx, srv, ln, 50*time.Millisecond, slog.New(slog.NewTextHandler(&logs, nil))) }()
		go func() {
			// The server cuts the connection, so the error is expected.
			if resp, err := http.Get("http://" + ln.Addr().String() + "/"); err == nil {
				_ = resp.Body.Close()
			}
		}()
		<-entered
		cancel()
		select {
		case err := <-served:
			if err != nil {
				t.Errorf("serve() = %v, want nil after the drain timed out", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("serve() did not return after a 50ms drain")
		}
		if got, want := logs.String(), `level=WARN msg="shutdown drain timed out" after=50ms`; !strings.Contains(got, want) {
			t.Errorf("serve() logged %q, want it to contain %q", got, want)
		}
	})

	t.Run("idle", func(t *testing.T) {
		srv := &http.Server{Handler: http.NotFoundHandler(), ReadHeaderTimeout: time.Second}
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("net.Listen() error = %v", err)
		}
		var logs bytes.Buffer
		ctx, cancel := context.WithCancel(context.Background())
		served := make(chan error, 1)
		go func() { served <- serve(ctx, srv, ln, time.Hour, slog.New(slog.NewTextHandler(&logs, nil))) }()
		cancel()
		select {
		case err := <-served:
			if err != nil {
				t.Errorf("serve() = %v, want nil", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("serve() of an idle server waited for the drain timeout")
		}
		if logs.Len() != 0 {
			t.Errorf("serve() of an idle server logged %q, want nothing", logs.String())
		}
	})
}

func TestKubernetesTokenWarning(t *testing.T) {
	catalog, err := profile.NewCatalog(nil, "")
	if err != nil {
		t.Fatalf("profile.NewCatalog() error = %v", err)
	}
	tests := []struct {
		name      string
		generated bool
		k8sHost   string
		wantWarn  bool
	}{
		{name: "generated in kubernetes", generated: true, k8sHost: "10.96.0.1", wantWarn: true},
		{name: "generated outside kubernetes", generated: true},
		{name: "set in kubernetes", k8sHost: "10.96.0.1"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(k string) string {
				if k == "KUBERNETES_SERVICE_HOST" {
					return tc.k8sHost
				}
				return ""
			}
			var logs bytes.Buffer
			cfg := config{listen: "0.0.0.0:8080", authToken: "abcXYZ0129._~-ok"} //nolint:gosec // test value, not a credential
			logStartup(slog.New(slog.NewTextHandler(&logs, nil)), getenv, cfg, "[::]:8080", catalog, tc.generated)
			var warn string
			for _, line := range strings.Split(logs.String(), "\n") {
				if strings.Contains(line, "level=WARN") {
					warn = line
				}
			}
			if got := warn != ""; got != tc.wantWarn {
				t.Fatalf("logStartup(generated=%v, KUBERNETES_SERVICE_HOST=%q) warned = %v, want %v; logs:\n%s",
					tc.generated, tc.k8sHost, got, tc.wantWarn, logs.String())
			}
			if want := "set LDAPUI_AUTH_TOKEN or LDAPUI_AUTH_TOKEN_FILE from a Secret"; tc.wantWarn && !strings.Contains(warn, want) {
				t.Errorf("logStartup() warning = %q, want it to contain %q", warn, want)
			}
		})
	}
}

func TestListeningLogFields(t *testing.T) {
	dir := t.TempDir()
	fixed := []profile.Profile{
		{Name: "fixed1", URL: "ldap://ldap1.example.com"},
		{Name: "fixed2", URL: "ldap://ldap2.example.com"},
	}
	catalog, err := profile.NewCatalog(fixed, dir)
	if err != nil {
		t.Fatalf("profile.NewCatalog() error = %v", err)
	}
	defer catalog.Close()
	if _, err := catalog.Save(profile.Profile{Name: "saved1", URL: "ldap://ldap3.example.com"}); err != nil {
		t.Fatalf("catalog.Save() error = %v", err)
	}

	var logs bytes.Buffer
	cfg := config{basePath: "/ldap", dataDir: dir}
	logStartup(slog.New(slog.NewJSONHandler(&logs, nil)), func(string) string { return "" }, cfg, "127.0.0.1:1234", catalog, false)
	var got map[string]any
	if err := json.NewDecoder(&logs).Decode(&got); err != nil {
		t.Fatalf("decoding the first log line: %v", err)
	}
	delete(got, "time")
	want := map[string]any{
		"level": "INFO", "msg": "listening", "version": "dev", "addr": "127.0.0.1:1234",
		"basePath": "/ldap", "profiles": 2.0, "saved": 1.0, "dataDir": dir,
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("logStartup() listening line mismatch (-want +got):\n%s", diff)
	}
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

func TestNewHTTPServerTimeouts(t *testing.T) {
	srv := newHTTPServer(http.NotFoundHandler())
	tests := []struct {
		name      string
		got, want time.Duration
	}{
		{name: "ReadHeaderTimeout", got: srv.ReadHeaderTimeout, want: 10 * time.Second},
		{name: "ReadTimeout", got: srv.ReadTimeout, want: 60 * time.Second},
		{name: "WriteTimeout", got: srv.WriteTimeout, want: 5 * time.Minute},
		{name: "IdleTimeout", got: srv.IdleTimeout, want: 2 * time.Minute},
	}
	for _, tc := range tests {
		if tc.got != tc.want {
			t.Errorf("newHTTPServer().%s = %v, want %v", tc.name, tc.got, tc.want)
		}
	}
	if got, want := srv.MaxHeaderBytes, 64<<10; got != want {
		t.Errorf("newHTTPServer().MaxHeaderBytes = %d, want %d", got, want)
	}
	// A search may run for the profile default searchTimeout (30s, unexported
	// in profile); the write deadline must leave room for long requests.
	if minWrite := 10 * 30 * time.Second; srv.WriteTimeout < minWrite {
		t.Errorf("newHTTPServer().WriteTimeout = %v, want at least %v", srv.WriteTimeout, minWrite)
	}
	if srv.Handler == nil {
		t.Errorf("newHTTPServer().Handler = nil, want the given handler")
	}
}

func TestNeedsToken(t *testing.T) {
	tests := []struct {
		listen       string
		allowedHosts []string
		want         bool
	}{
		{listen: "127.0.0.1:8080", want: false},
		{listen: "[::1]:8080", want: false},
		{listen: "localhost:8080", want: false},
		{listen: "0.0.0.0:8080", want: true},
		{listen: "127.0.0.1:8080", allowedHosts: []string{"ldap.example.com"}, want: true},
		{listen: ":8080", want: true},
	}
	for _, tc := range tests {
		if got := needsToken(tc.listen, tc.allowedHosts); got != tc.want {
			t.Errorf("needsToken(%q, %q) = %v, want %v", tc.listen, tc.allowedHosts, got, tc.want)
		}
	}
}
