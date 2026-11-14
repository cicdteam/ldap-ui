// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Andrei Taranik

//go:build ignore

// gen draws the demo avatars, a light head and shoulders on a coloured
// background, one 96x96 JPEG per colour. Run it once from this directory:
//
//	go run gen.go
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"log"
	"os"
)

const size = 96

var backgrounds = []color.RGBA{
	{0x4e, 0x79, 0xa7, 0xff},
	{0xf2, 0x8e, 0x2b, 0xff},
	{0x59, 0xa1, 0x4f, 0xff},
	{0xb0, 0x7a, 0xa1, 0xff},
	{0xe1, 0x57, 0x59, 0xff},
}

func main() {
	for i, bg := range backgrounds {
		if err := write(fmt.Sprintf("avatar-%d.jpg", i+1), avatar(bg)); err != nil {
			log.Fatal(err)
		}
	}
}

// avatar is a light head (a circle) over light shoulders (the top of a
// larger circle) on bg.
func avatar(bg color.RGBA) *image.RGBA {
	fg := color.RGBA{0xf4, 0xf1, 0xea, 0xff}
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	in := func(x, y, cx, cy, r int) bool { return (x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r }
	for y := range size {
		for x := range size {
			c := bg
			if in(x, y, size/2, size*3/8, size/5) || in(x, y, size/2, size*21/20, size*2/5) {
				c = fg
			}
			img.Set(x, y, c)
		}
	}
	return img
}

func write(name string, img image.Image) error {
	f, err := os.Create(name)
	if err != nil {
		return err
	}
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 80}); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
