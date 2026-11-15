// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

//go:build !unix || aix || solaris

package profile

import "os"

// ponytail: no data dir lock where syscall.Flock is missing (Windows, AIX,
// Solaris and illumos) and no directory sync (Windows cannot fsync a
// directory); add LockFileEx or fcntl locks if ldapui ships for them.
func lockDir(string) (*os.File, error) { return nil, nil }

func syncDir(string) error { return nil }
