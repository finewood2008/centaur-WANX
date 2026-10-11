package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeEngine struct {
	allow atomic.Bool
	dials atomic.Int32
	stops atomic.Int32
	start func(context.Context) error
	dial  func(context.Context, string, string) (net.Conn, error)
}

func (e *fakeEngine) Start(ctx context.Context) error {
	if e.start != nil {
		return e.start(ctx)
	}
	return nil
}
func (e *fakeEngine) Stop(context.Context) error { e.stops.Add(1); return nil }
func (e *fakeEngine) Status() networkStatus      { return state("ready", "") }
func (e *fakeEngine) Allowed(ip netip.Addr) bool {
	return e.allow.Load() && ip.String() == "100.90.1.2"
}
func (e *fakeEngine) DialContext(ctx context.Context, n, a string) (net.Conn, error) {
	e.dials.Add(1)
	return e.dial(ctx, n, a)
}
func connectProxy(t *testing.T, p *tunnelProxy, target, token, tail string) (net.Conn, *bufio.Reader, *http.Response) {
	t.Helper()
	conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p.info.Port)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, err = fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\n\r\n%s", target, target, token, tail)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	return conn, reader, resp
}
func TestProxyRequiresAuthenticationAndCurrentPeer(t *testing.T) {
	e := &fakeEngine{}
	e.allow.Store(true)
	p, err := newProxy(e)
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	for _, tc := range []struct {
		target, token string
		code          int
	}{{"100.90.1.2:8088", "wrong", 401}, {"127.0.0.1:8088", p.info.Token, 403}, {"example.com:8088", p.info.Token, 403}, {"100.90.1.2:0", p.info.Token, 403}} {
		_, _, r := connectProxy(t, p, tc.target, tc.token, "")
		r.Body.Close()
		if r.StatusCode != tc.code {
			t.Fatalf("got %d want %d", r.StatusCode, tc.code)
		}
	}
	e.allow.Store(false)
	_, _, r := connectProxy(t, p, "100.90.1.2:8088", p.info.Token, "")
	r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatal(r.StatusCode)
	}
	if e.dials.Load() != 0 {
		t.Fatal("unauthorized target reached dialer")
	}
}
func TestProxyPreservesConnectHeadAndClosesTunnels(t *testing.T) {
	e := &fakeEngine{}
	e.allow.Store(true)
	e.dial = func(ctx context.Context, n, a string) (net.Conn, error) {
		if n != "tcp" || a != "100.90.1.2:8088" {
			t.Errorf("unexpected dial %s %s", n, a)
		}
		client, server := net.Pipe()
		go func() { defer server.Close(); _, _ = io.Copy(server, server) }()
		return client, nil
	}
	p, err := newProxy(e)
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	conn, reader, r := connectProxy(t, p, "100.90.1.2:8088", p.info.Token, "first packet")
	if r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	buf := make([]byte, len("first packet"))
	if _, err := io.ReadFull(reader, buf); err != nil || string(buf) != "first packet" {
		t.Fatalf("lost CONNECT head: %q %v", buf, err)
	}
	payload := strings.Repeat("stream", 20000)
	done := make(chan error, 1)
	go func() { _, err := io.WriteString(conn, payload); done <- err }()
	buf = make([]byte, len(payload))
	if _, err := io.ReadFull(reader, buf); err != nil || string(buf) != payload {
		t.Fatalf("stream corrupt: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	p.close()
	if _, err = reader.ReadByte(); err == nil {
		t.Fatal("tunnel survived stop")
	}
	if _, err = net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p.info.Port)), 100*time.Millisecond); err == nil {
		t.Fatal("listener survived stop")
	}
}
