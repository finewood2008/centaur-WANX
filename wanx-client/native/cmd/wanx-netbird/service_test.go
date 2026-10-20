package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestStopCancelsStartWithoutPublishingLateProxy(t *testing.T) {
	started := make(chan struct{})
	e := &fakeEngine{start: func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() }}
	s := newService(func(startParams, string) (engine, error) { return e, nil })
	done := make(chan error, 1)
	go func() { _, err := s.start(context.Background(), startParams{}); done <- err }()
	<-started
	s.stop()
	select {
	case err := <-done:
		if err == nil || err.Error() != "cancelled" {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("stop blocked")
	}
	if s.status().Phase != "disabled" || s.proxy != nil {
		t.Fatal("cancelled start was published")
	}
	if e.stops.Load() != 1 {
		t.Fatal("engine not cleaned")
	}
}
func TestStopClearsCredentials(t *testing.T) {
	s := newService(nil)
	s.jwt = "sensitive"
	s.authManagement = "https://management.example"
	s.stop()
	if s.jwt != "" || s.authManagement != "" {
		t.Fatal("stop retained auth")
	}
}

func TestEOFCancelsPendingStart(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	e := &fakeEngine{start: func(ctx context.Context) error { close(started); <-ctx.Done(); close(cancelled); return ctx.Err() }}
	s := newService(func(startParams, string) (engine, error) { return e, nil })
	input, feed := io.Pipe()
	done := make(chan struct{})
	go func() { serve(context.Background(), input, io.Discard, s); close(done) }()
	params, _ := json.Marshal(startParams{ManagementURL: "https://example.com", ConfigDir: t.TempDir(), DeviceName: "test"})
	_, _ = io.WriteString(feed, `{"id":1,"method":"start","params":`+string(params)+"}\n")
	<-started
	feed.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("EOF did not terminate protocol")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("EOF did not cancel start")
	}
}

func TestStartIsIdempotentForSameClientOnly(t *testing.T) {
	e := &fakeEngine{}
	s := newService(func(startParams, string) (engine, error) { return e, nil })
	defer s.stop()
	p := startParams{ManagementURL: "https://example.com", ConfigDir: t.TempDir(), DeviceName: "test"}
	first, err := s.start(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.start(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	if string(a) != string(b) {
		t.Fatal("idempotent start replaced proxy")
	}
	p.ManagementURL = "https://other.example"
	if _, err = s.start(context.Background(), p); err == nil || err.Error() != "busy" {
		t.Fatal("running peer silently changed control plane")
	}
}
func TestNDJSONStopCanOvertakePendingStart(t *testing.T) {
	started := make(chan struct{})
	e := &fakeEngine{start: func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() }}
	s := newService(func(startParams, string) (engine, error) { return e, nil })
	input, feed := io.Pipe()
	client, output := net.Pipe()
	defer client.Close()
	done := make(chan struct{})
	go func() { serve(context.Background(), input, output, s); output.Close(); close(done) }()
	params, _ := json.Marshal(startParams{ManagementURL: "https://example.com", ConfigDir: t.TempDir(), DeviceName: "test"})
	_, _ = io.WriteString(feed, `{"id":1,"method":"start","params":`+string(params)+"}\n")
	<-started
	_, _ = io.WriteString(feed, "{\"id\":2,\"method\":\"stop\"}\n")
	client.SetReadDeadline(time.Now().Add(time.Second))
	reader := bufio.NewReader(client)
	seen := map[string]bool{}
	for range 2 {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var r response
		if json.Unmarshal(line, &r) != nil {
			t.Fatal(string(line))
		}
		seen[string(r.ID)] = true
	}
	if !seen["1"] || !seen["2"] {
		t.Fatal(seen)
	}
	feed.Close()
	<-done
}

func TestRecoverPreservesProxyAndNeverReusesEnrollmentKey(t *testing.T) {
	first, second := &fakeEngine{}, &fakeEngine{}
	calls := 0
	s := newService(func(p startParams, jwt string) (engine, error) {
		calls++
		if calls == 1 {
			return first, nil
		}
		if p.SetupKey != "" || jwt != "" {
			t.Fatal("recovery reused enrollment credentials")
		}
		return second, nil
	})
	defer s.stop()
	p := startParams{ManagementURL: "https://example.com", ConfigDir: t.TempDir(), DeviceName: "test", SetupKey: "one-time"}
	if _, err := s.start(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	proxy := s.proxy
	info := proxy.info
	if _, err := s.recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.proxy != proxy || s.proxy.info != info {
		t.Fatal("recovery replaced local gateway transport")
	}
	if first.stops.Load() != 1 || s.engine != second {
		t.Fatal("engine not replaced cleanly")
	}
}

func TestStopCancelsRecoveryAndClosesRetainedListener(t *testing.T) {
	started := make(chan struct{})
	first := &fakeEngine{}
	second := &fakeEngine{start: func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() }}
	calls := 0
	s := newService(func(startParams, string) (engine, error) {
		calls++
		if calls == 1 {
			return first, nil
		}
		return second, nil
	})
	if _, err := s.start(context.Background(), startParams{}); err != nil {
		t.Fatal(err)
	}
	proxy := s.proxy
	done := make(chan error, 1)
	go func() { _, err := s.recover(context.Background()); done <- err }()
	<-started
	if s.status().Phase != "recovering" {
		t.Fatal("pending recovery not reported")
	}
	s.stop()
	if err := <-done; err == nil || err.Error() != "cancelled" {
		t.Fatal(err)
	}
	if s.engine != nil || s.proxy != nil || !proxy.closed {
		t.Fatal("late recovery revived engine")
	}
}

func TestRecoveryFailureKeepsRetryableIdentityAndDisabledTunnel(t *testing.T) {
	calls := 0
	s := newService(func(startParams, string) (engine, error) {
		calls++
		if calls == 2 {
			return nil, failure("start_failed")
		}
		return &fakeEngine{}, nil
	})
	defer s.stop()
	if _, err := s.start(context.Background(), startParams{}); err != nil {
		t.Fatal(err)
	}
	proxy := s.proxy
	if _, err := s.recover(context.Background()); err == nil {
		t.Fatal("expected transient failure")
	}
	if s.status().Phase != "recovering" || s.proxy != proxy {
		t.Fatal("lost recoverable state")
	}
	_, _, response := connectProxy(t, proxy, "100.90.1.2:8088", proxy.info.Token, "")
	response.Body.Close()
	if response.StatusCode != 503 {
		t.Fatal(response.StatusCode)
	}
	if _, err := s.recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.status().Phase != "ready" {
		t.Fatal("retry failed")
	}
}

func TestRecoveryDeadlinePreservesRetryableProxy(t *testing.T) {
	calls := 0
	s := newService(func(startParams, string) (engine, error) {
		calls++
		if calls == 2 {
			return &fakeEngine{start: func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }}, nil
		}
		return &fakeEngine{}, nil
	})
	defer s.stop()
	if _, err := s.start(context.Background(), startParams{}); err != nil {
		t.Fatal(err)
	}
	proxy := s.proxy
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := s.recover(ctx); err == nil || err.Error() != "start_failed" {
		t.Fatal(err)
	}
	if s.proxy != proxy || proxy.closed || s.status().Phase != "recovering" {
		t.Fatal("deadline discarded recoverable transport")
	}
	if _, err := s.recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.proxy != proxy || s.status().Phase != "ready" {
		t.Fatal("retry replaced retained transport")
	}
}

func TestRecoveryExplicitCancellationRemainsCancelled(t *testing.T) {
	calls := 0
	ctx, cancel := context.WithCancel(context.Background())
	s := newService(func(startParams, string) (engine, error) {
		calls++
		if calls == 2 {
			return &fakeEngine{start: func(context.Context) error { cancel(); return context.Canceled }}, nil
		}
		return &fakeEngine{}, nil
	})
	defer s.stop()
	defer cancel()
	if _, err := s.start(context.Background(), startParams{}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.recover(ctx); err == nil || err.Error() != "cancelled" {
		t.Fatal(err)
	}
}

func TestRecoveryAuthDenialIsNotConvertedToRetryableDeadline(t *testing.T) {
	calls := 0
	s := newService(func(startParams, string) (engine, error) {
		calls++
		if calls == 2 {
			return &fakeEngine{start: func(ctx context.Context) error { <-ctx.Done(); return failure("auth_required") }}, nil
		}
		return &fakeEngine{}, nil
	})
	defer s.stop()
	if _, err := s.start(context.Background(), startParams{}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := s.recover(ctx); err == nil || err.Error() != "auth_required" {
		t.Fatal(err)
	}
}

// NetBird Status runs STUN/TURN health probes; a slow relay must not make the
// desktop's local status RPC wait for that external I/O on every refresh.
type delayedStatusEngine struct {
	fakeEngine
	reads   atomic.Int32
	release chan struct{}
	entered chan struct{}
}

func (e *delayedStatusEngine) Status() networkStatus {
	n := e.reads.Add(1)
	if n > 1 {
		if n == 2 && e.entered != nil {
			close(e.entered)
		}
		<-e.release
	}
	result := state("ready", "")
	result.Peers = []peerInfo{{IP: "100.80.1.2", Connected: n == 1}}
	return result
}
func TestStatusDoesNotWaitForRepeatedHealthProbe(t *testing.T) {
	e := &delayedStatusEngine{release: make(chan struct{})}
	s := newService(func(startParams, string) (engine, error) { return e, nil })
	defer s.stop()
	defer close(e.release)
	if _, err := s.start(context.Background(), startParams{}); err != nil {
		t.Fatal(err)
	}
	done := make(chan networkStatus, 1)
	go func() { done <- s.status() }()
	select {
	case status := <-done:
		if status.Phase != "ready" {
			t.Fatalf("unexpected status: %+v", status)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("local status RPC blocked on the SDK's external health probe")
	}
}

func TestHealthSamplingIsSingleFlightAndStaleObservationsCannotStayOnline(t *testing.T) {
	e := &delayedStatusEngine{release: make(chan struct{}), entered: make(chan struct{})}
	s := newService(func(startParams, string) (engine, error) { return e, nil })
	defer s.stop()
	released := false
	defer func() {
		if !released {
			close(e.release)
		}
	}()
	if _, err := s.start(context.Background(), startParams{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-e.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("health sampler did not run")
	}
	for range 20 {
		if got := s.status(); got.Phase != "ready" || !got.Peers[0].Connected {
			t.Fatal(got)
		}
	}
	if e.reads.Load() != 2 {
		t.Fatal("status RPC spawned parallel health probes")
	}
	// A fresh copy prevents an IPC consumer from altering the sampler's result.
	s.status().Peers[0].Connected = false
	if !s.status().Peers[0].Connected {
		t.Fatal("status observation was mutable")
	}
	s.mu.Lock()
	s.statusAt = time.Now().Add(-statusMaxAge)
	s.mu.Unlock()
	if got := s.status(); got.Phase != "recovering" || len(got.Peers) != 0 {
		t.Fatalf("stale health advertised online: %+v", got)
	}
	close(e.release)
	released = true
	deadline := time.Now().Add(time.Second)
	for {
		got := s.status()
		if got.Phase == "ready" && len(got.Peers) == 1 && !got.Peers[0].Connected {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("latest health result not published: %+v", got)
		}
		time.Sleep(time.Millisecond)
	}
}
func TestStoppedSamplerCannotPublishLateHealth(t *testing.T) {
	e := &delayedStatusEngine{release: make(chan struct{}), entered: make(chan struct{})}
	s := newService(func(startParams, string) (engine, error) { return e, nil })
	defer s.stop()
	defer close(e.release)
	if _, err := s.start(context.Background(), startParams{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-e.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("health sampler did not run")
	}
	s.stop()
	if got := s.status(); got.Phase != "disabled" || len(got.Peers) != 0 {
		t.Fatal(got)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.statusAt.IsZero() || s.statusStop != nil {
		t.Fatal("stop retained health observation")
	}
}
