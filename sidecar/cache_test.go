package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestUploadFileCached verifies a shared file (e.g. a master) is transferred once
// and skipped on subsequent calls while its content is unchanged.
func TestUploadFileCached(t *testing.T) {
	dataDir := t.TempDir()
	_, addr := newTestServer(t, dataDir, Capabilities{NodeID: "w1"})
	ctx := context.Background()

	master := filepath.Join(t.TempDir(), "masterDark.xisf")
	if err := os.WriteFile(master, []byte("master-dark-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	up, err := UploadFileCached(ctx, addr, master)
	if err != nil {
		t.Fatal(err)
	}
	if !up {
		t.Fatal("first UploadFileCached should transfer the file")
	}
	up, err = UploadFileCached(ctx, addr, master)
	if err != nil {
		t.Fatal(err)
	}
	if up {
		t.Fatal("second UploadFileCached should skip (worker already has it)")
	}

	// changing the content must force a re-upload
	if err := os.WriteFile(master, []byte("master-dark-bytes-v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	up, err = UploadFileCached(ctx, addr, master)
	if err != nil {
		t.Fatal(err)
	}
	if !up {
		t.Fatal("changed content should re-upload")
	}
}

// TestMockDrizzleOutput verifies the mock executor emits a .xdrz alongside each
// registered frame when Drizzle is requested (exercises the drizzle path).
func TestMockDrizzleOutput(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "light_0001.xisf"), []byte("f"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := MockExecutor{}.Process(dataDir, WorkManifest{
		InputNames: []string{"light_0001.xisf"}, OutputPostfix: "_r", OutputExt: ".xisf", Drizzle: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	var xisf, xdrz bool
	for _, o := range out {
		if o.Output == "light_0001_r.xisf" {
			xisf = true
		}
		if o.Output == "light_0001_r.xdrz" {
			xdrz = true
		}
	}
	if !xisf || !xdrz {
		t.Fatalf("expected both _r.xisf and _r.xdrz, got %+v", out)
	}
}
