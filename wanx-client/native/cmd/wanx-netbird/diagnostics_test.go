package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDiagnosticsAreOptInAndReplaceOnlyTheSnapshot(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "network.json")
	snapshot := networkDiagnostics{Peers: []peerDiagnostics{{IP: "100.80.1.2", Connected: true, LocalCandidate: candidateKind("SECRET-candidate"), RemoteCandidate: candidateKind("relay")}}, Relays: []relayDiagnostics{{Healthy: false}}}
	writeNetworkDiagnostics("", snapshot)
	files, _ := os.ReadDir(dir)
	if len(files) != 0 {
		t.Fatal("disabled diagnostics wrote files")
	}
	writeNetworkDiagnostics(destination, snapshot)
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("diagnostics must remain private")
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "SECRET") {
		t.Fatal("candidate text leaked")
	}
	var value networkDiagnostics
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	if value.Peers[0].LocalCandidate != "unknown" || value.Peers[0].RemoteCandidate != "relay" {
		t.Fatal(value)
	}
	snapshot.Peers = []peerDiagnostics{}
	writeNetworkDiagnostics(destination, snapshot)
	data, _ = os.ReadFile(destination)
	if strings.Contains(string(data), "100.80.1.2") {
		t.Fatal("old peer survived replacement")
	}
	files, _ = os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatal("temporary diagnostics leaked")
	}
}
func TestDiagnosticsFailureCannotAffectNetworkHealth(t *testing.T) {
	writeNetworkDiagnostics(filepath.Join(t.TempDir(), "missing", "network.json"), networkDiagnostics{})
	writeNetworkDiagnostics("relative-diagnostics-must-not-exist.json", networkDiagnostics{})
	if _, err := os.Stat("relative-diagnostics-must-not-exist.json"); !os.IsNotExist(err) {
		t.Fatal("relative output path accepted")
	}
}

func TestSlowDiagnosticsCannotBlockHealthSamplingOrGrowTheQueue(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var writes atomic.Int32
	writer := newDiagnosticWriter(func(string, networkDiagnostics) {
		if writes.Add(1) == 1 {
			close(started)
			<-release
		}
	})
	writer.submit("unused", networkDiagnostics{})
	<-started
	submitted := make(chan struct{})
	go func() {
		for range 10000 {
			writer.submit("unused", networkDiagnostics{})
		}
		close(submitted)
	}()
	select {
	case <-submitted:
	case <-time.After(100 * time.Millisecond):
		close(release)
		t.Fatal("slow diagnostic storage blocked health sampling")
	}
	if len(writer.queue) != 1 {
		t.Fatal("diagnostic queue not bounded")
	}
	close(writer.queue)
	close(release)
	<-writer.done
	if writes.Load() != 2 {
		t.Fatal("diagnostic I/O grew with dropped samples")
	}
}

func TestRelayDiagnosticsExposeOnlyKnownKindsAndTransports(t *testing.T) {
	for _, item := range []struct{ uri, kind string }{
		{"stun:SECRET", "stun"}, {"stuns:SECRET", "stun"},
		{"turn:SECRET?credential=SECRET", "turn"}, {"turns:SECRET", "turn"},
		{"rels://SECRET@SECRET/path?token=SECRET", "relay"}, {"rel://SECRET", "relay"},
		{"SECRET://SECRET", "unknown"}, {"SECRET", "unknown"},
	} {
		if got := relayKind(item.uri); got != item.kind {
			t.Fatalf("unexpected relay kind: %q", got)
		}
	}
	for _, value := range []string{"quic", "ws"} {
		if relayTransport(value) != value {
			t.Fatal("known transport rejected")
		}
	}
	if relayTransport("SECRET") != "unknown" {
		t.Fatal("arbitrary transport text leaked")
	}
}
