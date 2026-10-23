// wanx-netbird owns an application-only, userspace NetBird peer. stdout is a
// private NDJSON channel to the desktop main process, never a logging sink.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/sirupsen/logrus"
)

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type rpcError struct {
	Code string `json:"code"`
}

func (e *rpcError) Error() string { return e.Code }
func failure(code string) error   { return &rpcError{Code: code} }

type response struct {
	ID     json.RawMessage `json:"id"`
	Result any             `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

func serve(ctx context.Context, input io.Reader, output io.Writer, s *service) {
	var writes sync.Mutex
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 4096), 64*1024)
	for scan.Scan() {
		var req request
		if json.Unmarshal(scan.Bytes(), &req) != nil || len(req.ID) == 0 {
			continue
		}
		// A pending device login or start must never prevent stop being handled.
		go func(req request) {
			result, err := s.dispatch(ctx, req.Method, req.Params)
			resp := response{ID: req.ID, Result: result}
			if err != nil {
				resp.Result = nil
				resp.Error = &rpcError{Code: err.Error()}
			}
			writes.Lock()
			defer writes.Unlock()
			_ = json.NewEncoder(output).Encode(resp)
		}(req)
	}
	s.stop()
}

func main() {
	// Upstream logs can include authentication details. Only sanitized protocol
	// errors cross the process boundary; credentials are never logged.
	logrus.SetOutput(io.Discard)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	s := newService(newEmbeddedEngine)
	done := make(chan struct{})
	go func() { serve(ctx, os.Stdin, os.Stdout, s); close(done) }()
	select {
	case <-ctx.Done():
	case <-done:
	}
	stopped := make(chan struct{})
	go func() { s.stop(); close(stopped) }()
	// The upstream login routine currently does not honor Start's context in
	// every phase. Process termination is the final bound on its lifecycle.
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
	}
}
