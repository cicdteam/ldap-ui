// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

// Package web holds the built single-page UI. "make web" fills web/dist with
// the Vite build output; a fresh checkout embeds only a placeholder file.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist returns the built UI rooted at dist/.
func Dist() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // unreachable: "dist" is a valid path embedded above
	}
	return sub
}
