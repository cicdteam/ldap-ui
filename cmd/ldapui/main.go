// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

// Command ldapui serves a web UI for browsing LDAP directories.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/cicdteam/ldap-ui/internal/api"
	"github.com/cicdteam/ldap-ui/internal/ldapx"
	"github.com/cicdteam/ldap-ui/internal/profile"
	"github.com/cicdteam/ldap-ui/internal/session"
	"github.com/cicdteam/ldap-ui/web"
)

// version is set at build time by -ldflags "-X main.version=...".
var version = "dev"

type config struct {
	listen        string
	basePath      string
	configPath    string
	dataDir       string
	authToken     string
	allowedHosts  []string
	sessionIdle   time.Duration
	secureCookies bool
	showVersion   bool
}

var (
	basePathPattern = regexp.MustCompile(`^(/[A-Za-z0-9._-]+)*/?$`)
	// authTokenPattern keeps tokens safe in cookies and URLs without escaping.
	authTokenPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{16,}$`)
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "ldapui:", err)
		os.Exit(1)
	}
}

// parseFlags reads flags with environment fallbacks. Usage and flag errors
// go to usage. With --version nothing else is validated, so it works
// whatever the environment holds.
func parseFlags(args []string, getenv func(string) string, usage io.Writer) (config, error) {
	env := func(name, def string) string {
		if v := getenv(name); v != "" {
			return v
		}
		return def
	}
	secure := false
	var secureErr error
	if v := getenv("LDAPUI_SECURE_COOKIES"); v != "" {
		if secure, secureErr = strconv.ParseBool(v); secureErr != nil {
			secureErr = fmt.Errorf("LDAPUI_SECURE_COOKIES %q: want true or false", v)
		}
	}
	var c config
	var hosts string
	fs := flag.NewFlagSet("ldapui", flag.ContinueOnError)
	fs.SetOutput(usage)
	fs.StringVar(&c.listen, "listen", env("LDAPUI_LISTEN", "127.0.0.1:8080"), "address to listen on (env LDAPUI_LISTEN)")
	fs.StringVar(&c.basePath, "base-path", env("LDAPUI_BASE_PATH", ""), "URL prefix behind a reverse proxy, e.g. /ldap (env LDAPUI_BASE_PATH)")
	fs.StringVar(&c.configPath, "config", env("LDAPUI_CONFIG", ""), "connections.yaml path (env LDAPUI_CONFIG)")
	fs.StringVar(&c.dataDir, "data-dir", env("LDAPUI_DATA_DIR", ""), "directory for profiles created in the UI (env LDAPUI_DATA_DIR)")
	// No env default here: flag prints non-empty defaults in usage output.
	fs.StringVar(&c.authToken, "auth-token", "", "access token; generated when listening beyond loopback (env LDAPUI_AUTH_TOKEN)")
	fs.StringVar(&hosts, "allowed-hosts", env("LDAPUI_ALLOWED_HOSTS", ""), "extra Host header values to accept, comma-separated (env LDAPUI_ALLOWED_HOSTS)")
	fs.DurationVar(&c.sessionIdle, "session-idle", 30*time.Minute, "close LDAP connections after this much inactivity")
	fs.BoolVar(&c.secureCookies, "secure-cookies", secure, "mark cookies Secure when served over HTTPS, e.g. behind a TLS ingress (env LDAPUI_SECURE_COOKIES)")
	fs.BoolVar(&c.showVersion, "version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if c.showVersion {
		return c, nil
	}
	if secureErr != nil {
		return config{}, secureErr
	}
	if c.authToken == "" {
		c.authToken = getenv("LDAPUI_AUTH_TOKEN")
	}
	for _, h := range strings.Split(hosts, ",") {
		if h = strings.TrimSpace(h); h != "" {
			c.allowedHosts = append(c.allowedHosts, h)
		}
	}
	if c.sessionIdle <= 0 {
		return config{}, fmt.Errorf("--session-idle %v: want a positive duration", c.sessionIdle)
	}
	if !basePathPattern.MatchString(c.basePath) {
		return config{}, fmt.Errorf("--base-path %q: want a path like /ldap", c.basePath)
	}
	c.basePath = strings.TrimRight(c.basePath, "/")
	// The token is a secret, so the error does not echo it.
	if c.authToken != "" && !authTokenPattern.MatchString(c.authToken) {
		return config{}, errors.New("--auth-token: want at least 16 characters from A-Z, a-z, 0-9 and . _ ~ -")
	}
	return c, nil
}

// isLoopback reports whether addr (host:port) only accepts local connections.
func isLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// loginURL is the link printed when a token was generated. Inside a
// container the published host port may differ; the log line says so.
func loginURL(listenAddr, basePath, token string) string {
	_, port, _ := net.SplitHostPort(listenAddr)
	return "http://localhost:" + port + basePath + "/?token=" + url.QueryEscape(token)
}

func dial(ctx context.Context, p profile.Profile, password string) (api.Directory, error) {
	c, err := ldapx.Dial(ctx, p, password)
	if err != nil {
		return nil, err // a nil *ldapx.Conn must not become a non-nil interface
	}
	return c, nil
}

func run(args []string) error { return runTo(args, os.Stdout) }

// runTo is run with the --version output going to stdout.
func runTo(args []string, stdout io.Writer) error {
	cfg, err := parseFlags(args, os.Getenv, os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return nil // usage is printed; -h is not a failure
	}
	if err != nil {
		return err
	}
	if cfg.showVersion {
		_, err = fmt.Fprintf(stdout, "ldapui %s\n", version)
		return err
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	var fixed []profile.Profile
	if cfg.configPath != "" {
		if fixed, err = profile.Load(cfg.configPath); err != nil {
			return err
		}
	}
	catalog, err := profile.NewCatalog(fixed, cfg.dataDir)
	if err != nil {
		return err
	}

	generated := false
	if cfg.authToken == "" && !isLoopback(cfg.listen) {
		cfg.authToken, generated = rand.Text(), true
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	sessions := session.New[api.Directory](cfg.sessionIdle)
	go sessions.Run(ctx)

	srv := &http.Server{
		Handler: api.New(api.Options{
			Catalog: catalog, Dial: dial, Sessions: sessions,
			AllowedHosts: cfg.allowedHosts, AuthToken: cfg.authToken, BasePath: cfg.basePath,
			SecureCookies: cfg.secureCookies, UI: web.Dist(), Logger: logger,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.listen)
	if err != nil {
		return err
	}
	logger.Info("listening", "version", version, "addr", ln.Addr().String(), "basePath", cfg.basePath, "profiles", len(fixed))
	if generated {
		logger.Info("no --auth-token set; open the UI with this login link (adjust the port if it is published differently)",
			"url", loginURL(ln.Addr().String(), cfg.basePath, cfg.authToken))
	}

	// Restore default signal handling once shutdown starts, so a second
	// Ctrl-C exits immediately.
	context.AfterFunc(ctx, stop)
	// ponytail: open LDAP sessions are left to process exit; session has no close-all.
	return serve(ctx, srv, ln)
}

// serve runs srv on ln until ctx is done, then waits up to 5s for in-flight
// requests to finish.
func serve(ctx context.Context, srv *http.Server, ln net.Listener) error {
	shutdown := make(chan error, 1)
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		shutdown <- srv.Shutdown(shutdownCtx)
	}()
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return <-shutdown
}
