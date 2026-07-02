package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// WorkManifest describes one shard of a distributed WBPP operation: the process
// to run (serialized by PixInsight via ProcessInstance.toSource on the server)
// and the input frames to run it over. Files referenced by name are expected to
// already be present in the worker's data dir (uploaded beforehand via /upload).
type WorkManifest struct {
	JobID         string   `json:"job_id"`
	Op            string   `json:"op"`             // "registration" | "calibration" | ...
	ProcessSource string   `json:"process_source"` // PJSR source of the configured process
	ReferenceName string   `json:"reference_name"` // legacy single shared ref (registration); prefer FileRefFields
	InputNames    []string `json:"input_names"`    // this shard's frames (already uploaded)
	OutputPrefix  string   `json:"output_prefix"`  // process outputPrefix ("" usually)
	OutputPostfix string   `json:"output_postfix"` // e.g. "_r" (StarAlignment), "_c" (ImageCalibration)
	OutputExt     string   `json:"output_ext"`     // e.g. ".xisf"

	// Generic distribution (used by the PJSR worker to reconstruct the process):
	TargetsField  string            `json:"targets_field"`   // "targetFrames" (IC) | "targets" (SA)
	PathIndex     int               `json:"path_index"`      // index of the path within a target row (1 or 2)
	FileRefFields map[string]string `json:"file_ref_fields"` // process field -> shared file basename (masters/reference), rewritten to local
	Drizzle       bool              `json:"drizzle"`         // also collect <base><postfix>.xdrz outputs
}

// OutputPair maps one input frame to its produced output, with the output's
// checksum so the server can verify the file it later downloads.
type OutputPair struct {
	Input  string `json:"input"`
	Output string `json:"output"` // filename within the worker's data dir
	SHA256 string `json:"sha256"`
}

// WorkResult is returned by a worker after processing a shard.
type WorkResult struct {
	OK      bool         `json:"ok"`
	JobID   string       `json:"job_id"`
	Outputs []OutputPair `json:"outputs"`
	Error   string       `json:"error,omitempty"`
}

// Executor turns a WorkManifest into output files inside dataDir. There are two
// real implementations:
//
//   - PixInsightExecutor: the production path. The sidecar does NOT run
//     PixInsight itself; it hands the manifest to the local PixInsight worker
//     script (which polls over localhost), waits for it to write the registered
//     frames, and reports them back. (Wired in Jalon 3 once the PJSR worker
//     exists.)
//   - MockExecutor: copies each input to "<base><postfix><ext>", mimicking
//     StarAlignment's "_r" output naming. Lets us validate the entire
//     shard/transfer/collect pipeline end-to-end with no PixInsight involved.
type Executor interface {
	// Process runs the manifest and returns the produced files (names within dataDir).
	Process(dataDir string, m WorkManifest) ([]OutputPair, error)
}

// MockExecutor stands in for PixInsight during plumbing tests.
type MockExecutor struct{}

func (MockExecutor) Process(dataDir string, m WorkManifest) ([]OutputPair, error) {
	out := make([]OutputPair, 0, len(m.InputNames))
	postfix := m.OutputPostfix
	if postfix == "" {
		postfix = "_out"
	}
	ext := m.OutputExt
	for _, in := range m.InputNames {
		src := filepath.Join(dataDir, in)
		base := strings.TrimSuffix(in, filepath.Ext(in))
		useExt := ext
		if useExt == "" {
			useExt = filepath.Ext(in)
		}
		outName := m.OutputPrefix + base + postfix + useExt
		dst := filepath.Join(dataDir, outName)
		if err := copyFile(src, dst); err != nil {
			return nil, fmt.Errorf("mock process %q: %w", in, err)
		}
		sum, err := fileSHA256(dst)
		if err != nil {
			return nil, err
		}
		out = append(out, OutputPair{Input: in, Output: outName, SHA256: sum})

		// mimic StarAlignment drizzle output so the drizzle path is testable
		if m.Drizzle {
			drz := m.OutputPrefix + base + postfix + ".xdrz"
			ddst := filepath.Join(dataDir, drz)
			if err := os.WriteFile(ddst, []byte("mock-drizzle:"+in), 0o644); err == nil {
				if s, e := fileSHA256(ddst); e == nil {
					out = append(out, OutputPair{Input: in, Output: drz, SHA256: s})
				}
			}
		}
	}
	return out, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
