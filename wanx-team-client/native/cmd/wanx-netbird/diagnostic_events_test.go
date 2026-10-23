package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/sirupsen/logrus"
)

func TestDiagnosticEventsAcceptOnlySDKTemplatesWithoutRawMessages(t *testing.T) {
	hook := newDiagnosticEvents()
	peer := base64.StdEncoding.EncodeToString(make([]byte, 32))
	messages := []string{
		"sending offer with serial: SECRET, relay server: rels://SECRET, relay IP: SECRET",
		"failed to send offer: SECRET signal error",
		"SECRET sending offer with serial: SECRET",
		"received offer, running version 0.80.0, remote WireGuard listen port 5000, session id: SECRET, remote ICE supported: true, relay server: rels://SECRET, relay IP: SECRET",
		"received answer, running version 0.80.0, remote WireGuard listen port 5000, session id: SECRET, remote ICE supported: true, relay server: rels://SECRET, relay IP: SECRET",
		"Relay is not supported by remote peer",
		"failed to open connection via Relay: SECRET relay token",
		"start to communicate with peer via relay",
		"failed to handle new offer: SECRET token",
		"failed to send remote offer confirmation: SECRET token",
		"unknown event SECRET",
		"SECRET received offer, running version 0.80.0",
	}
	for _, message := range messages {
		_ = hook.Fire(&logrus.Entry{Message: message, Data: logrus.Fields{"peer": peer, "token": "SECRET"}})
	}
	got := hook.snapshot(peer)
	if got.SentOffer != 1 || got.SendOfferFailed != 1 || got.RemoteOffer != 1 || got.RemoteAnswer != 1 || got.RelayUnsupported != 1 || got.RelayOpenFailed != 1 || got.RelayOpened != 1 || got.RelayHomeUnavailable != 1 || got.SendAnswerFailed != 1 {
		t.Fatalf("wrong fixed counts: %+v", got)
	}
	serialized, _ := json.Marshal(got)
	if strings.Contains(string(serialized), "SECRET") || strings.Contains(string(serialized), peer) || strings.Contains(string(serialized), "rels:") {
		t.Fatal("raw SDK context leaked")
	}
}
func TestDiagnosticEventsIgnoreMissingOrInvalidPeerIdentity(t *testing.T) {
	hook := newDiagnosticEvents()
	for _, data := range []logrus.Fields{nil, {"peer": "SECRET"}, {"peer": 123}, {"peer": strings.Repeat("A", 5000)}} {
		_ = hook.Fire(&logrus.Entry{Message: "failed to open connection via Relay: SECRET", Data: data})
	}
	if len(hook.peers) != 0 {
		t.Fatal("unvalidated identity retained")
	}
}
func TestDiagnosticEventsMemoryIsBounded(t *testing.T) {
	hook := newDiagnosticEvents()
	for i := range 1024 {
		key := make([]byte, 32)
		key[0] = byte(i)
		key[1] = byte(i >> 8)
		_ = hook.Fire(&logrus.Entry{Message: "Relay is not supported by remote peer", Data: logrus.Fields{"peer": base64.StdEncoding.EncodeToString(key)}})
	}
	if len(hook.peers) != 256 {
		t.Fatal("unbounded diagnostic peer state")
	}
}

func TestDiagnosticEventsAreSafeDuringConcurrentStatusReads(t *testing.T) {
	hook := newDiagnosticEvents()
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	var work sync.WaitGroup
	for range 20 {
		work.Add(1)
		go func() {
			defer work.Done()
			for range 100 {
				_ = hook.Fire(&logrus.Entry{Message: "Relay is not supported by remote peer", Data: logrus.Fields{"peer": key}})
				_ = hook.snapshot(key)
			}
		}()
	}
	work.Wait()
	if hook.snapshot(key).RelayUnsupported != 2000 {
		t.Fatal("lost concurrent diagnostic events")
	}
}

func TestConnectionDiagnosticStateIsAnEnum(t *testing.T) {
	for input, expected := range map[string]string{"Idle": "idle", "Connecting": "connecting", "Connected": "connected", "INVALID_PEER_CONNECTION_STATUS": "unknown", "SECRET": "unknown", "Connected SECRET": "unknown"} {
		if actual := connectionState(input); actual != expected {
			t.Fatalf("unexpected connection enum: %s", actual)
		}
	}
}
