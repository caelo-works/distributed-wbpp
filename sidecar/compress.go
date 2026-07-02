package main

import "github.com/klauspost/compress/zstd"

// On-the-wire frame compression: byte-shuffle + zstd. Astro pixel data is Float32
// noise (high entropy) that generic compressors barely touch (~1.15x). Deinterleaving
// the 4 bytes of each float into contiguous planes groups the similar high-order bytes,
// lifting the ratio to ~1.3-1.5x — and zstd level 1 then runs FASTER than on the raw
// bytes (500+ MB/s), so it is a net win even on a 1Gbps LAN (more so when the server's
// NIC is shared across workers). The checksum is always verified on the DECOMPRESSED
// bytes, so integrity is unchanged.
const shuffleElem = 4 // Float32

var (
	// EncodeAll/DecodeAll are safe for concurrent use, so one shared pair suffices.
	zstdEnc, _ = zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedFastest), zstd.WithEncoderConcurrency(1))
	zstdDec, _ = zstd.NewReader(nil, zstd.WithDecoderConcurrency(1))
)

// shuffleBytes deinterleaves the largest shuffleElem-multiple prefix into byte-planes,
// leaving any remainder tail as-is (reversible from the length alone).
func shuffleBytes(data []byte) []byte {
	n := len(data)
	m := n - n%shuffleElem
	if m == 0 {
		return data
	}
	out := make([]byte, n)
	cnt := m / shuffleElem
	for i := 0; i < cnt; i++ {
		base := i * shuffleElem
		for p := 0; p < shuffleElem; p++ {
			out[p*cnt+i] = data[base+p]
		}
	}
	copy(out[m:], data[m:])
	return out
}

func unshuffleBytes(data []byte) []byte {
	n := len(data)
	m := n - n%shuffleElem
	if m == 0 {
		return data
	}
	out := make([]byte, n)
	cnt := m / shuffleElem
	for i := 0; i < cnt; i++ {
		base := i * shuffleElem
		for p := 0; p < shuffleElem; p++ {
			out[base+p] = data[p*cnt+i]
		}
	}
	copy(out[m:], data[m:])
	return out
}

// packFrame shuffles then zstd-compresses; unpackFrame reverses it.
func packFrame(data []byte) []byte { return zstdEnc.EncodeAll(shuffleBytes(data), nil) }

func unpackFrame(packed []byte) ([]byte, error) {
	raw, err := zstdDec.DecodeAll(packed, nil)
	if err != nil {
		return nil, err
	}
	return unshuffleBytes(raw), nil
}
