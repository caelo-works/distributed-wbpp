package main

import (
	"bytes"
	"math/rand"
	"testing"
)

func TestShuffleRoundTrip(t *testing.T) {
	for _, n := range []int{0, 1, 3, 4, 5, 7, 8, 16, 33, 4095, 4096, 4097} {
		src := make([]byte, n)
		for i := range src {
			src[i] = byte(i*7 + 1)
		}
		got := unshuffleBytes(shuffleBytes(src))
		if !bytes.Equal(got, src) {
			t.Fatalf("n=%d shuffle round-trip mismatch", n)
		}
	}
}

func TestPackFrameRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for _, n := range []int{0, 1, 3, 4, 7, 4096, 100003, 1 << 20} {
		src := make([]byte, n)
		rng.Read(src)
		got, err := unpackFrame(packFrame(src))
		if err != nil {
			t.Fatalf("n=%d unpack: %v", n, err)
		}
		if !bytes.Equal(got, src) {
			t.Fatalf("n=%d pack round-trip mismatch (len %d)", n, len(got))
		}
	}
}
