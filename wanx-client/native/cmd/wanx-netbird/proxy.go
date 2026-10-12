package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"
)

type proxyInfo struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}
type tunnelProxy struct {
	info        proxyInfo
	engine      engine
	server      *http.Server
	ctx         context.Context
	cancel      context.CancelFunc
	mu          sync.Mutex
	closed      bool
	generation  uint64
	connections map[net.Conn]struct{}
}

func newProxy(e engine) (*tunnelProxy, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, failure("proxy_failed")
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		listener.Close()
		return nil, failure("proxy_failed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &tunnelProxy{info: proxyInfo{Port: listener.Addr().(*net.TCPAddr).Port, Token: hex.EncodeToString(secret)}, engine: e, ctx: ctx, cancel: cancel, connections: map[net.Conn]struct{}{}}
	p.server = &http.Server{Handler: p, ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 8192, IdleTimeout: 30 * time.Second}
	go func() { _ = p.server.Serve(listener) }()
	return p, nil
}
func (p *tunnelProxy) track(c net.Conn, generation uint64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.generation != generation {
		return false
	}
	p.connections[c] = struct{}{}
	return true
}
func (p *tunnelProxy) release(c net.Conn) {
	c.Close()
	p.mu.Lock()
	delete(p.connections, c)
	p.mu.Unlock()
}

// Keep the authenticated loopback listener while replacing only the network
// engine. Old TCP/WebSocket connections are closed, never replayed.
func (p *tunnelProxy) replaceEngine(e engine) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cancel()
	p.generation++
	p.engine = e
	for c := range p.connections {
		c.Close()
	}
	p.ctx, p.cancel = context.WithCancel(context.Background())
	if p.closed {
		p.cancel()
	}
}
func (p *tunnelProxy) close() {
	p.mu.Lock()
	p.cancel()
	p.closed = true
	for c := range p.connections {
		c.Close()
	}
	p.mu.Unlock()
	p.server.Close()
}
func (p *tunnelProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+p.info.Token)) != 1 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodConnect {
		http.Error(w, "CONNECT required", http.StatusMethodNotAllowed)
		return
	}
	p.mu.Lock()
	e, parent, generation := p.engine, p.ctx, p.generation
	closed := p.closed
	p.mu.Unlock()
	if e == nil || closed {
		http.Error(w, "Recovering", http.StatusServiceUnavailable)
		return
	}
	host, port, err := net.SplitHostPort(r.Host)
	ip, ipErr := netip.ParseAddr(host)
	n, portErr := strconv.Atoi(port)
	if err != nil || ipErr != nil || portErr != nil || n < 1 || n > 65535 || ip.Zone() != "" || !e.Allowed(ip.Unmap()) {
		http.Error(w, "Unknown peer", http.StatusForbidden)
		return
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	upstream, err := e.DialContext(ctx, "tcp", net.JoinHostPort(ip.Unmap().String(), port))
	cancel()
	if err != nil {
		http.Error(w, "Peer unavailable", http.StatusBadGateway)
		return
	}
	if !p.track(upstream, generation) {
		upstream.Close()
		http.Error(w, "Stopped", http.StatusServiceUnavailable)
		return
	}
	defer p.release(upstream)
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Unavailable", http.StatusInternalServerError)
		return
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return
	}
	if !p.track(conn, generation) {
		conn.Close()
		return
	}
	defer p.release(conn)
	if _, err = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if rw.Flush() != nil {
		return
	}
	// rw.Reader includes any bytes sent in the same packet as CONNECT. Every
	// tunnel uses two bounded copy buffers, never whole-response buffering.
	done := make(chan struct{}, 1)
	go func() {
		_, _ = io.CopyBuffer(upstream, rw.Reader, make([]byte, 32*1024))
		if c, ok := upstream.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		} else {
			_ = upstream.Close()
		}
		done <- struct{}{}
	}()
	_, _ = io.CopyBuffer(conn, upstream, make([]byte, 32*1024))
	conn.Close()
	upstream.Close()
	<-done
}
