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
	"net/netip"
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

	identityHeader string
	trustedProxies []netip.Prefix
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
	var hosts, proxies string
	fs := flag.NewFlagSet("ldapui", flag.ContinueOnError)
	fs.SetOutput(usage)
	fs.StringVar(&c.listen, "listen", env("LDAPUI_LISTEN", "127.0.0.1:8080"), "address to listen on (env LDAPUI_LISTEN)")
	fs.StringVar(&c.basePath, "base-path", env("LDAPUI_BASE_PATH", ""), "URL prefix behind a reverse proxy, e.g. /ldap (env LDAPUI_BASE_PATH)")
	fs.StringVar(&c.configPath, "config", env("LDAPUI_CONFIG", ""), "connections.yaml path (env LDAPUI_CONFIG)")
	fs.StringVar(&c.dataDir, "data-dir", env("LDAPUI_DATA_DIR", ""), "directory for profiles created in the UI (env LDAPUI_DATA_DIR)")
	// No env default here: flag prints non-empty defaults in usage output.
	fs.StringVar(&c.authToken, "auth-token", "", "access token; generated when not on loopback or when --allowed-hosts is set (env LDAPUI_AUTH_TOKEN)")
	fs.StringVar(&hosts, "allowed-hosts", env("LDAPUI_ALLOWED_HOSTS", ""), "extra Host header values to accept, comma-separated (env LDAPUI_ALLOWED_HOSTS)")
	fs.DurationVar(&c.sessionIdle, "session-idle", 30*time.Minute, "close LDAP connections after this much inactivity")
	fs.StringVar(&c.identityHeader, "identity-header", env("LDAPUI_IDENTITY_HEADER", ""),
		"header an authenticating proxy sets to the user, e.g. X-Auth-Request-Email; logged as user (env LDAPUI_IDENTITY_HEADER)")
	fs.StringVar(&proxies, "trusted-proxies", env("LDAPUI_TRUSTED_PROXIES", ""),
		"CIDRs or IPs of the proxies whose --identity-header is logged, comma-separated (env LDAPUI_TRUSTED_PROXIES)")
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
	for _, v := range strings.Split(proxies, ",") {
		if v = strings.TrimSpace(v); v == "" {
			continue
		}
		p, err := parsePrefix(v)
		if err != nil {
			return config{}, fmt.Errorf("--trusted-proxies: %w", err)
		}
		c.trustedProxies = append(c.trustedProxies, p)
	}
	// Without trusted proxies any client could set the header.
	if c.identityHeader != "" && len(c.trustedProxies) == 0 {
		return config{}, errors.New("--identity-header needs --trusted-proxies, the addresses of the proxy that sets it")
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

// parsePrefix parses a CIDR, or a bare IP as a prefix of that one address.
func parsePrefix(s string) (netip.Prefix, error) {
	if ip, err := netip.ParseAddr(s); err == nil {
		ip = ip.Unmap()
		return netip.PrefixFrom(ip, ip.BitLen()), nil
	}
	p, err := netip.ParsePrefix(s)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("%q is not a CIDR or an IP address", s)
	}
	return p, nil
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

// needsToken reports whether the UI must require a token. With
// --allowed-hosts on loopback, a reverse proxy forwards remote clients, so
// loopback alone no longer means local.
func needsToken(listen string, allowedHosts []string) bool {
	return !isLoopback(listen) || len(allowedHosts) > 0
}

// newHTTPServer returns a server for h with timeouts that stop slow or idle
// clients from holding connections. WriteTimeout is ten times the profile
// default searchTimeout (30s), so long searches and large applies finish.
func newHTTPServer(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}
}

// loginURL is the link printed when a token was generated. Behind a proxy or
// inside a container the host and port may differ; the log line says so.
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
	defer catalog.Close()
	if path := catalog.Quarantined(); path != "" {
		logger.Warn("profiles file was invalid and was moved aside", "path", path)
	}
	if catalog.Unlocked() {
		logger.Warn("data dir is not writable; saving profiles will fail", "dir", cfg.dataDir)
	}

	generated := false
	if cfg.authToken == "" && needsToken(cfg.listen, cfg.allowedHosts) {
		cfg.authToken, generated = rand.Text(), true
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	sessions := session.New[api.Directory](cfg.sessionIdle)
	go sessions.Run(ctx)

	srv := newHTTPServer(api.New(api.Options{
		Catalog: catalog, Dial: dial, Sessions: sessions,
		AllowedHosts: cfg.allowedHosts, AuthToken: cfg.authToken, BasePath: cfg.basePath,
		SecureCookies: cfg.secureCookies, IdentityHeader: cfg.identityHeader, TrustedProxies: cfg.trustedProxies,
		UI: web.Dist(), Logger: logger,
	}))
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.listen)
	if err != nil {
		return err
	}
	logger.Info("listening", "version", version, "addr", ln.Addr().String(), "basePath", cfg.basePath, "profiles", len(fixed))
	if generated {
		logger.Info("no --auth-token set; open the UI with this login link (adjust the host and port to how you reach it)",
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
