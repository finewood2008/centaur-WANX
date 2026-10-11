package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
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
