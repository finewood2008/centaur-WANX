package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Opt-in local observations only. Never serialize SDK structs, error text,
// endpoints or authentication material: they can contain relay credentials.
type networkDiagnostics struct {
	ObservedAt          string             `json:"observedAt"`
	ManagementConnected bool               `json:"managementConnected"`
	SignalConnected     bool               `json:"signalConnected"`
	Peers               []peerDiagnostics  `json:"peers"`
	Relays              []relayDiagnostics `json:"relays"`
}
type peerDiagnostics struct {
	ConnectionState string          `json:"connectionState"`
	Events          peerEventCounts `json:"events"`
	IP              string          `json:"ip"`
	Connected       bool            `json:"connected"`
	Relayed         bool            `json:"relayed"`
	LocalCandidate  string          `json:"localCandidate"`
	RemoteCandidate string          `json:"remoteCandidate"`
	LastHandshake   string          `json:"lastHandshake,omitempty"`
	BytesTx         int64           `json:"bytesTx"`
	BytesRx         int64           `json:"bytesRx"`
}
type relayDiagnostics struct {
	Healthy   bool   `json:"healthy"`
	Kind      string `json:"kind"`
	Transport string `json:"transport"`
}

func candidateKind(value string) string {
	switch value {
	case "host", "srflx", "prflx", "relay":
		return value
	}
	return "unknown"
}

// Replace a single 0600 snapshot atomically. Diagnostic I/O cannot affect the
// transport; the caller explicitly supplies an existing private directory.
func writeNetworkDiagnostics(destination string, snapshot networkDiagnostics) {
	if !filepath.IsAbs(destination) {
		return
	}
	file, err := os.CreateTemp(filepath.Dir(destination), ".network-diagnostics-*")
	if err != nil {
		return
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	err = json.NewEncoder(file).Encode(snapshot)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return
	}
	_ = os.Rename(temporary, destination)
}

// One process-wide worker and one queued sample bound memory/I/O even if a
// selected diagnostic filesystem stalls. Losing a diagnostic sample must never
// delay the engine's health sampler; observedAt makes its freshness explicit.
type diagnosticRequest struct {
	destination string
	snapshot    networkDiagnostics
}
type diagnosticWriter struct {
	queue chan diagnosticRequest
	done  chan struct{}
}

func newDiagnosticWriter(write func(string, networkDiagnostics)) *diagnosticWriter {
	writer := &diagnosticWriter{queue: make(chan diagnosticRequest, 1), done: make(chan struct{})}
	go func() {
		defer close(writer.done)
		for request := range writer.queue {
			write(request.destination, request.snapshot)
		}
	}()
	return writer
}
func (writer *diagnosticWriter) submit(destination string, snapshot networkDiagnostics) {
	select {
	case writer.queue <- diagnosticRequest{destination, snapshot}:
	default:
	}
}

var diagnosticsOnce sync.Once
var diagnosticsOutput *diagnosticWriter

func publishNetworkDiagnostics(destination string, snapshot networkDiagnostics) {
	if !filepath.IsAbs(destination) {
		return
	}
	diagnosticsOnce.Do(func() { diagnosticsOutput = newDiagnosticWriter(writeNetworkDiagnostics) })
	diagnosticsOutput.submit(destination, snapshot)
}

func relayKind(value string) string {
	scheme, _, _ := strings.Cut(value, ":")
	switch strings.ToLower(scheme) {
	case "stun", "stuns":
		return "stun"
	case "turn", "turns":
		return "turn"
	case "rel", "rels":
		return "relay"
	default:
		return "unknown"
	}
}
func relayTransport(value string) string {
	switch value {
	case "quic", "ws":
		return value
	default:
		return "unknown"
	}
}

func connectionState(value string) string {
	switch value {
	case "Idle":
		return "idle"
	case "Connecting":
		return "connecting"
	case "Connected":
		return "connected"
	default:
		return "unknown"
	}
}
