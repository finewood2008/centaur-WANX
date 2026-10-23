package main

import (
	"encoding/base64"
	"strings"
	"sync"

	"github.com/sirupsen/logrus"
)

// Only fixed event counters leave this hook. Peer public keys stay in memory
// solely to join SDK events to the validated IP in its next status snapshot.
type peerEventCounts struct {
	SentOffer            uint64 `json:"sentOffer"`
	SendOfferFailed      uint64 `json:"sendOfferFailed"`
	RemoteOffer          uint64 `json:"remoteOffer"`
	RemoteAnswer         uint64 `json:"remoteAnswer"`
	RelayUnsupported     uint64 `json:"relayUnsupported"`
	RelayOpenFailed      uint64 `json:"relayOpenFailed"`
	RelayOpened          uint64 `json:"relayOpened"`
	RelayHomeUnavailable uint64 `json:"relayHomeUnavailable"`
	SendAnswerFailed     uint64 `json:"sendAnswerFailed"`
}
type diagnosticEvents struct {
	mu    sync.Mutex
	peers map[string]peerEventCounts
}

func newDiagnosticEvents() *diagnosticEvents {
	return &diagnosticEvents{peers: make(map[string]peerEventCounts)}
}
func (*diagnosticEvents) Levels() []logrus.Level {
	return []logrus.Level{logrus.DebugLevel, logrus.InfoLevel, logrus.ErrorLevel}
}
func (events *diagnosticEvents) Fire(entry *logrus.Entry) error {
	key, ok := entry.Data["peer"].(string)
	if !ok || len(key) != 44 {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decoded) != 32 {
		return nil
	}
	kind := ""
	switch {
	case strings.HasPrefix(entry.Message, "sending offer with serial: "):
		kind = "send-offer"
	case strings.HasPrefix(entry.Message, "failed to send offer: "):
		kind = "send-offer-failed"
	case strings.HasPrefix(entry.Message, "received offer, running version "):
		kind = "offer"
	case strings.HasPrefix(entry.Message, "received answer, running version "):
		kind = "answer"
	case entry.Message == "Relay is not supported by remote peer":
		kind = "unsupported"
	case strings.HasPrefix(entry.Message, "failed to open connection via Relay: "):
		kind = "open-failed"
	case entry.Message == "start to communicate with peer via relay":
		kind = "opened"
	case strings.HasPrefix(entry.Message, "failed to handle new offer: "):
		kind = "home-unavailable"
	case strings.HasPrefix(entry.Message, "failed to send remote offer confirmation: "):
		kind = "answer-failed"
	default:
		return nil
	}
	events.mu.Lock()
	defer events.mu.Unlock()
	counts, exists := events.peers[key]
	if !exists && len(events.peers) >= 256 {
		return nil
	}
	switch kind {
	case "send-offer":
		counts.SentOffer++
	case "send-offer-failed":
		counts.SendOfferFailed++
	case "offer":
		counts.RemoteOffer++
	case "answer":
		counts.RemoteAnswer++
	case "unsupported":
		counts.RelayUnsupported++
	case "open-failed":
		counts.RelayOpenFailed++
	case "opened":
		counts.RelayOpened++
	case "home-unavailable":
		counts.RelayHomeUnavailable++
	case "answer-failed":
		counts.SendAnswerFailed++
	}
	events.peers[key] = counts
	return nil
}
func (events *diagnosticEvents) snapshot(key string) peerEventCounts {
	events.mu.Lock()
	defer events.mu.Unlock()
	return events.peers[key]
}

var networkDiagnosticEvents = newDiagnosticEvents()
var diagnosticEventsOnce sync.Once

func enableDiagnosticEvents() {
	diagnosticEventsOnce.Do(func() { logrus.AddHook(networkDiagnosticEvents) })
}
