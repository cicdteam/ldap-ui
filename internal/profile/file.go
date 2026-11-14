// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

package profile

import (
	"errors"
	"fmt"
	"io"
	"os"

	"go.yaml.in/yaml/v3"
)

// Load reads profiles from a YAML file of the form
//
//	connections:
//	  - name: corp-ad
//	    url: ldaps://dc1.corp.example:636
//	    bindDN: cn=reader,dc=corp,dc=example
//	    passwordEnv: CORP_AD_PASSWORD
//
// Unknown keys are rejected so typos do not silently drop settings.
func Load(path string) ([]Profile, error) {
	f, err := os.Open(path) //nolint:gosec // path is the operator's --config flag
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var doc struct {
		Connections []Profile `yaml:"connections"`
	}
	dec := yaml.NewDecoder(f)
	dec.KnownFields(true)
	if err := dec.Decode(&doc); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := normalizeAll(doc.Connections); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return doc.Connections, nil
}

// normalizeAll validates ps in place and rejects duplicate names.
func normalizeAll(ps []Profile) error {
	seen := make(map[string]bool, len(ps))
	for i := range ps {
		if err := ps[i].normalize(); err != nil {
			return err
		}
		if seen[ps[i].Name] {
			return fmt.Errorf("%w: duplicate name %q", ErrInvalid, ps[i].Name)
		}
		seen[ps[i].Name] = true
	}
	return nil
}
