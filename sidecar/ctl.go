package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// runCtl implements the `wbpp-sidecar ctl <cmd>` subcommands. These are tiny
// HTTP clients to a *local* long-lived sidecar daemon (agent or worker). PixInsight
// drives them via ExternalProcess + files, because PJSR cannot reliably do HTTP
// itself (NetworkTransfer) nor capture child stdout — so every ctl command reads
// its input from a file and writes its result to a file.
//
//	ctl pull   --control-port P --out-file job.json
//	    GET /v1/work on the local worker daemon; writes the manifest (or {} if
//	    there is no pending work) to out-file.
//	ctl result --control-port P --in-file result.json
//	    POST /v1/work/result on the local worker daemon with the file's contents.
func runCtl(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: wbpp-sidecar ctl pull|result [flags]")
		os.Exit(2)
	}
	cmd := args[0]
	fs := flag.NewFlagSet("ctl "+cmd, flag.ExitOnError)
	controlPort := fs.Int("control-port", 48099, "local daemon control port")
	outFile := fs.String("out-file", "", "write the response to this file")
	inFile := fs.String("in-file", "", "read the request body from this file")
	_ = fs.Parse(args[1:])

	base := fmt.Sprintf("http://127.0.0.1:%d", *controlPort)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	switch cmd {
	case "pull":
		body, status := ctlGet(ctx, base+"/v1/work")
		// 204 => no pending work; normalize to an empty object so PJSR can parse.
		if status == http.StatusNoContent || len(bytes.TrimSpace(body)) == 0 {
			body = []byte("{}")
		}
		writeOut(*outFile, body)
	case "result":
		if *inFile == "" {
			fmt.Fprintln(os.Stderr, "ctl result: --in-file required")
			os.Exit(2)
		}
		payload, err := os.ReadFile(*inFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "ctl result: read in-file:", err)
			os.Exit(1)
		}
		body, _ := ctlPost(ctx, base+"/v1/work/result", payload)
		writeOut(*outFile, body)
	case "nodes":
		// list workers discovered by the local persistent agent
		body, _ := ctlGet(ctx, base+"/v1/nodes")
		writeOut(*outFile, body)
	case "distribute":
		// submit a DistributeJob (from --in-file) to the local agent; the agent
		// uses its continuously-updated worker registry, so no per-call discovery.
		if *inFile == "" {
			fmt.Fprintln(os.Stderr, "ctl distribute: --in-file required")
			os.Exit(2)
		}
		payload, err := os.ReadFile(*inFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "ctl distribute: read in-file:", err)
			os.Exit(1)
		}
		// no timeout: a big group can take a long time to register
		body, _ := ctlPost(context.Background(), base+"/v1/distribute", payload)
		writeOut(*outFile, body)
	default:
		fmt.Fprintln(os.Stderr, "unknown ctl command:", cmd)
		os.Exit(2)
	}
}

func ctlGet(ctx context.Context, url string) ([]byte, int) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ctl: GET failed:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b, resp.StatusCode
}

func ctlPost(ctx context.Context, url string, payload []byte) ([]byte, int) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ctl: POST failed:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b, resp.StatusCode
}

// writeOut writes to the given file, or to stdout if no file was requested.
func writeOut(path string, body []byte) {
	if path == "" {
		fmt.Println(string(body))
		return
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "ctl: write out-file:", err)
		os.Exit(1)
	}
}

// distributeFromFile is the server one-shot path: read a DistributeJob from a
// file, discover workers, run it, and write the JobReport to out-file. Used by
// the PJSR WBPPShim so it never has to speak HTTP.
func distributeFromFile(ctx context.Context, self Capabilities, reg *Registry, jobFile, outFile string, discoverTO time.Duration) {
	raw, err := os.ReadFile(jobFile)
	if err != nil {
		fatalJSON(outFile, "read job-file: "+err.Error())
	}
	var job DistributeJob
	if err := json.Unmarshal(raw, &job); err != nil {
		fatalJSON(outFile, "parse job-file: "+err.Error())
	}
	workers := waitForWorkers(ctx, reg, discoverTO)
	if len(workers) == 0 {
		fatalJSON(outFile, "no workers discovered")
	}
	rep, err := distributeJob(ctx, self, workers, job, nil)
	if err != nil {
		// still emit the partial report alongside the error
		out := map[string]any{"error": err.Error(), "report": rep}
		b, _ := json.MarshalIndent(out, "", "  ")
		writeOut(outFile, b)
		os.Exit(1)
	}
	b, _ := json.MarshalIndent(rep, "", "  ")
	writeOut(outFile, b)
}

func fatalJSON(outFile, msg string) {
	b, _ := json.MarshalIndent(map[string]string{"error": msg}, "", "  ")
	writeOut(outFile, b)
	os.Exit(1)
}
