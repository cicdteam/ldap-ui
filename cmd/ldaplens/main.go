// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

// Command ldaplens serves a web UI for browsing LDAP directories.
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
	"path"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/cicdteam/ldaplens/internal/api"
	"github.com/cicdteam/ldaplens/internal/ldapx"
	"github.com/cicdteam/ldaplens/internal/profile"
	"github.com/cicdteam/ldaplens/internal/session"
	"github.com/cicdteam/ldaplens/web"
)

// version is set at build time by -ldflags "-X main.version=...".
var version = "dev"

type config struct {
	listen        string
	basePath      string
	configPath    string
	dataDir       string
	authToken     string
	authTokenFile string
	allowedHosts  []string
	sessionIdle   time.Duration
	sessionMaxAge time.Duration
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

// authTokenRule describes authTokenPattern in errors, which never echo the
// token itself.
const authTokenRule = "want at least 16 characters from A-Z, a-z, 0-9 and . _ ~ -"

// drainTimeout bounds how long shutdown waits for in-flight requests. It
// stays under the 30s Kubernetes default terminationGracePeriodSeconds.
const drainTimeout = 25 * time.Second

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "ldaplens:", err)
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
	if v := getenv("LDAPLENS_SECURE_COOKIES"); v != "" {
		if secure, secureErr = strconv.ParseBool(v); secureErr != nil {
			secureErr = fmt.Errorf("LDAPLENS_SECURE_COOKIES %q: want true or false", v)
		}
	}
	idle := 30 * time.Minute
	var idleErr error
	if v := getenv("LDAPLENS_SESSION_IDLE"); v != "" {
		if idle, idleErr = time.ParseDuration(v); idleErr != nil {
			idleErr = fmt.Errorf("LDAPLENS_SESSION_IDLE %q: want a duration like 30m", v)
		}
	}
	maxAge := 8 * time.Hour
	var maxAgeErr error
	if v := getenv("LDAPLENS_SESSION_MAX_AGE"); v != "" {
		if maxAge, maxAgeErr = time.ParseDuration(v); maxAgeErr != nil {
			maxAgeErr = fmt.Errorf("LDAPLENS_SESSION_MAX_AGE %q: want a duration like 8h", v)
		}
	}
	var c config
	var hosts, proxies string
	fs := flag.NewFlagSet("ldaplens", flag.ContinueOnError)
	fs.SetOutput(usage)
	fs.StringVar(&c.listen, "listen", env("LDAPLENS_LISTEN", "127.0.0.1:8080"), "address to listen on (env LDAPLENS_LISTEN)")
	fs.StringVar(&c.basePath, "base-path", env("LDAPLENS_BASE_PATH", ""), "URL prefix behind a reverse proxy, e.g. /ldap (env LDAPLENS_BASE_PATH)")
	fs.StringVar(&c.configPath, "config", env("LDAPLENS_CONFIG", ""), "connections.yaml path (env LDAPLENS_CONFIG)")
	fs.StringVar(&c.dataDir, "data-dir", env("LDAPLENS_DATA_DIR", ""), "directory for profiles created in the UI (env LDAPLENS_DATA_DIR)")
	// No env default here: flag prints non-empty defaults in usage output.
	fs.StringVar(&c.authToken, "auth-token", "", "access token; generated when not on loopback or when --allowed-hosts is set (env LDAPLENS_AUTH_TOKEN)")
	// No env default either, so that a token flag can override both token
	// variables.
	fs.StringVar(&c.authTokenFile, "auth-token-file", "", "file holding the access token, e.g. a mounted Secret; read at startup (env LDAPLENS_AUTH_TOKEN_FILE)")
	fs.StringVar(&hosts, "allowed-hosts", env("LDAPLENS_ALLOWED_HOSTS", ""), "extra Host header values to accept, comma-separated (env LDAPLENS_ALLOWED_HOSTS)")
	fs.DurationVar(&c.sessionIdle, "session-idle", idle, "close LDAP connections after this much inactivity (env LDAPLENS_SESSION_IDLE)")
	fs.DurationVar(&c.sessionMaxAge, "session-max-age", maxAge, "close each LDAP connection this long after it was connected, however active (env LDAPLENS_SESSION_MAX_AGE)")
	fs.StringVar(&c.identityHeader, "identity-header", env("LDAPLENS_IDENTITY_HEADER", ""),
		"header an authenticating proxy sets to the user, e.g. X-Auth-Request-Email; logged as user, and for identityUser profiles it decides which username a person may sign in as (env LDAPLENS_IDENTITY_HEADER)")
	fs.StringVar(&proxies, "trusted-proxies", env("LDAPLENS_TRUSTED_PROXIES", ""),
		"CIDRs or IPs of the proxies whose --identity-header is trusted, comma-separated (env LDAPLENS_TRUSTED_PROXIES)")
	fs.BoolVar(&c.secureCookies, "secure-cookies", secure, "mark cookies Secure when served over HTTPS, e.g. behind a TLS ingress (env LDAPLENS_SECURE_COOKIES)")
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
	if idleErr != nil {
		return config{}, idleErr
	}
	if maxAgeErr != nil {
		return config{}, maxAgeErr
	}
	// A token flag overrides both token variables.
	switch {
	case c.authToken != "" && c.authTokenFile != "":
		return config{}, errors.New("--auth-token and --auth-token-file: set one of them")
	case c.authToken == "" && c.authTokenFile == "":
		c.authToken, c.authTokenFile = getenv("LDAPLENS_AUTH_TOKEN"), getenv("LDAPLENS_AUTH_TOKEN_FILE")
		if c.authToken != "" && c.authTokenFile != "" {
			return config{}, errors.New("LDAPLENS_AUTH_TOKEN and LDAPLENS_AUTH_TOKEN_FILE: set one of them")
		}
	}
	if c.authTokenFile != "" {
		token, err := readTokenFile(c.authTokenFile)
		if err != nil {
			return config{}, fmt.Errorf("--auth-token-file: %w", err)
		}
		c.authToken = token
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
	// These carry the browser's or the proxy's credentials, which must not
	// reach the log.
	for _, h := range []string{"Authorization", "Proxy-Authorization", "Cookie"} {
		if strings.EqualFold(c.identityHeader, h) {
			return config{}, fmt.Errorf("--identity-header %s: carries credentials; want the header the proxy sets to the user", c.identityHeader)
		}
	}
	if c.sessionIdle <= 0 {
		return config{}, fmt.Errorf("--session-idle %v: want a positive duration", c.sessionIdle)
	}
	if c.sessionMaxAge <= 0 {
		return config{}, fmt.Errorf("--session-max-age %v: want a positive duration", c.sessionMaxAge)
	}
	if !basePathPattern.MatchString(c.basePath) {
		return config{}, fmt.Errorf("--base-path %q: want a path like /ldap", c.basePath)
	}
	c.basePath = strings.TrimRight(c.basePath, "/")
	if c.basePath != "" && path.Clean(c.basePath) != c.basePath {
		return config{}, fmt.Errorf("--base-path %q: want a path without . or .. segments", c.basePath)
	}
	// The token is a secret, so the error does not echo it.
	if c.authToken != "" && !authTokenPattern.MatchString(c.authToken) {
		return config{}, errors.New("--auth-token: " + authTokenRule)
	}
	return c, nil
}

// readTokenFile reads the token from path, such as a mounted Kubernetes
// Secret. It drops one trailing "\n" or "\r\n", which editors and
// "echo > file" add. The error names path but never echoes the token.
func readTokenFile(path string) (string, error) {
	b, err := os.ReadFile(path) //nolint:gosec // path is the operator's --auth-token-file
	if err != nil {
		return "", err
	}
	token, ok := strings.CutSuffix(string(b), "\n")
	if ok {
		token = strings.TrimSuffix(token, "\r")
	}
	if !authTokenPattern.MatchString(token) {
		return "", fmt.Errorf("token in %s: %s", path, authTokenRule)
	}
	return token, nil
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
		_, err = fmt.Fprintf(stdout, "ldaplens %s\n", version)
		return err
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	var fixed []profile.Profile
	if cfg.configPath != "" {
		if fixed, err = profile.Load(cfg.configPath); err != nil {
			return err
		}
	}
	// Without the header there is no identity, so every connect would fail.
	for _, p := range fixed {
		if p.IdentityUser != "" && cfg.identityHeader == "" {
			return fmt.Errorf("profile %s: identityUser needs --identity-header, the header the authenticating proxy sets to the user", p.Name)
		}
	}
	catalog, err := profile.NewCatalog(fixed, cfg.dataDir)
	if err != nil {
		return err
	}
	defer catalog.Close()
	if moved, reason := catalog.Quarantined(); moved != "" {
		logger.Warn("profiles file was invalid and was moved aside", "path", moved, "error", reason)
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

	sessions := session.New[api.Directory](cfg.sessionIdle, cfg.sessionMaxAge)
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
	logStartup(logger, os.Getenv, cfg, ln.Addr().String(), catalog, generated)

	// Restore default signal handling once shutdown starts, so a second
	// Ctrl-C exits immediately.
	context.AfterFunc(ctx, stop)
	// ponytail: open LDAP sessions are left to process exit; session has no close-all.
	return serve(ctx, srv, ln, drainTimeout, logger)
}

// logStartup logs the listening line and, for a generated token, the login
// link. Inside Kubernetes a generated token also gets a warning: it differs
// per pod and changes on every restart, which breaks login.
func logStartup(logger *slog.Logger, getenv func(string) string, cfg config, addr string, catalog *profile.Catalog, generated bool) {
	fixed, saved := catalog.All()
	logger.Info("listening", "version", version, "addr", addr, "basePath", cfg.basePath,
		"profiles", len(fixed), "saved", len(saved), "dataDir", cfg.dataDir)
	if !generated {
		return
	}
	logger.Info("no --auth-token set; open the UI with this login link (adjust the host and port to how you reach it)",
		"url", loginURL(addr, cfg.basePath, cfg.authToken))
	if getenv("KUBERNETES_SERVICE_HOST") != "" {
		logger.Warn("generated token in Kubernetes: it changes on every restart and differs per replica; " +
			"set LDAPLENS_AUTH_TOKEN or LDAPLENS_AUTH_TOKEN_FILE from a Secret")
	}
}

// serve runs srv on ln until ctx is done, then waits up to drain for
// in-flight requests to finish. After that it closes the remaining
// connections and still returns nil: a slow client is no reason to exit 1.
func serve(ctx context.Context, srv *http.Server, ln net.Listener, drain time.Duration, logger *slog.Logger) error {
	shutdown := make(chan error, 1)
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), drain)
		defer cancel()
		err := srv.Shutdown(shutdownCtx)
		if errors.Is(err, context.DeadlineExceeded) {
			_ = srv.Close() // cutting the slow connections is no failure either
			err = nil
			logger.Warn("shutdown drain timed out", "after", drain)
		}
		shutdown <- err
	}()
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return <-shutdown
}
