// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

// Package profile loads and stores LDAP connection profiles.
package profile

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// Environment tells the user how careful to be with a connection.
type Environment string

// Known environments.
const (
	Dev   Environment = "dev"
	Stage Environment = "stage"
	Prod  Environment = "prod"
)

const (
	defaultConnectTimeout = 10 * time.Second
	defaultSearchTimeout  = 30 * time.Second
)

// ErrInvalid marks a profile that fails validation.
var ErrInvalid = errors.New("invalid profile")

// namePattern keeps profile names safe to use as a URL path segment.
var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Profile describes how to connect to one LDAP server.
//
// Fields tagged json:"-" can only come from the config file: the HTTP API
// must never be able to point the server at a local file or environment
// variable.
type Profile struct {
	Name               string        `yaml:"name" json:"name"`
	URL                string        `yaml:"url" json:"url"`
	StartTLS           bool          `yaml:"startTLS" json:"startTLS"`
	BaseDN             string        `yaml:"baseDN" json:"baseDN,omitempty"`
	BindDN             string        `yaml:"bindDN" json:"bindDN,omitempty"`
	PasswordEnv        string        `yaml:"passwordEnv" json:"-"`
	PasswordFile       string        `yaml:"passwordFile" json:"-"`
	CAFile             string        `yaml:"caFile" json:"-"`
	CAPEM              string        `yaml:"caPEM" json:"caPEM,omitempty"`
	InsecureSkipVerify bool          `yaml:"insecureSkipVerify" json:"insecureSkipVerify"`
	Environment        Environment   `yaml:"environment" json:"environment"`
	Color              string        `yaml:"color" json:"color,omitempty"`
	ReadOnly           *bool         `yaml:"readOnly" json:"readOnly,omitempty"`
	ConnectTimeout     time.Duration `yaml:"connectTimeout" json:"-"`
	SearchTimeout      time.Duration `yaml:"searchTimeout" json:"-"`
}

// IsReadOnly reports whether writes are disabled. Prod profiles are
// read-only unless the profile sets readOnly: false explicitly.
func (p Profile) IsReadOnly() bool {
	if p.ReadOnly != nil {
		return *p.ReadOnly
	}
	return p.Environment == Prod
}

// normalize validates p and fills in defaults. It is idempotent.
func (p *Profile) normalize() error {
	if !namePattern.MatchString(p.Name) {
		return fmt.Errorf("%w: name %q must match %s", ErrInvalid, p.Name, namePattern)
	}
	u, err := url.Parse(p.URL)
	if err != nil {
		// url.Error repeats the raw URL, which may hold a password; keep only the cause.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return fmt.Errorf("%w: %s: url: %w", ErrInvalid, p.Name, err)
	}
	switch u.Scheme {
	case "ldap":
	case "ldaps":
		if p.StartTLS {
			return fmt.Errorf("%w: %s: startTLS cannot be combined with ldaps://", ErrInvalid, p.Name)
		}
	default:
		return fmt.Errorf("%w: %s: url scheme must be ldap or ldaps, got %q", ErrInvalid, p.Name, u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("%w: %s: url has no host", ErrInvalid, p.Name)
	}
	if u.User != nil {
		return fmt.Errorf("%w: %s: url must not contain credentials", ErrInvalid, p.Name)
	}
	switch p.Environment {
	case "":
		p.Environment = Dev
	case Dev, Stage, Prod:
	default:
		return fmt.Errorf("%w: %s: environment must be dev, stage or prod, got %q", ErrInvalid, p.Name, p.Environment)
	}
	if p.ConnectTimeout <= 0 {
		p.ConnectTimeout = defaultConnectTimeout
	}
	if p.SearchTimeout <= 0 {
		p.SearchTimeout = defaultSearchTimeout
	}
	return nil
}

// ConfiguredPassword returns the bind password from PasswordEnv or
// PasswordFile. ok is false when the profile configures neither, in which
// case the user has to type the password.
func (p Profile) ConfiguredPassword() (password string, ok bool, err error) {
	switch {
	case p.PasswordEnv != "":
		v, set := os.LookupEnv(p.PasswordEnv)
		if !set {
			return "", false, fmt.Errorf("profile %s: environment variable %s is not set", p.Name, p.PasswordEnv)
		}
		return v, true, nil
	case p.PasswordFile != "":
		b, err := os.ReadFile(p.PasswordFile) //nolint:gosec // path comes from the operator's config file
		if err != nil {
			return "", false, fmt.Errorf("profile %s: %w", p.Name, err)
		}
		return strings.TrimRight(string(b), "\r\n"), true, nil
	}
	return "", false, nil
}

// TLSConfig returns the TLS settings for ldaps:// and StartTLS. Custom CAs
// from CAFile and CAPEM are added to the system pool.
func (p Profile) TLSConfig() (*tls.Config, error) {
	u, err := url.Parse(p.URL)
	if err != nil {
		return nil, fmt.Errorf("profile %s: url: %w", p.Name, err)
	}
	cfg := &tls.Config{
		ServerName:         u.Hostname(),
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: p.InsecureSkipVerify, //nolint:gosec // explicit per-profile opt-in, flagged in the UI
	}
	if p.CAFile == "" && p.CAPEM == "" {
		return cfg, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	pemData := []byte(p.CAPEM)
	if p.CAFile != "" {
		b, err := os.ReadFile(p.CAFile) //nolint:gosec // path comes from the operator's config file
		if err != nil {
			return nil, fmt.Errorf("profile %s: %w", p.Name, err)
		}
		pemData = append(append(pemData, '\n'), b...)
	}
	if !pool.AppendCertsFromPEM(pemData) {
		return nil, fmt.Errorf("profile %s: no PEM certificates in CA data", p.Name)
	}
	cfg.RootCAs = pool
	return cfg, nil
}
