// Package wanx combines the supplied Connectivity SDK with WANX native API access.
package wanx

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git/go/connectivity"
	"codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git/go/consumer"
	"codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git/go/omniaauth"
)

//go:embed operations.json
var inventory []byte

//go:embed application-operations.json
var applicationInventory []byte

//go:embed brainstorm-operations.json
var brainstormInventory []byte

type Operation struct {
	ID         string `json:"operationId"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	Parameters []struct {
		In   string `json:"in"`
		Name string `json:"name"`
	} `json:"parameters"`
	matcher *regexp.Regexp
}
type Policy struct {
	ApplicationID string   `json:"applicationId"`
	Operations    []string `json:"operations"`
	Agents        []string `json:"agents"`
	Sockets       []string `json:"sockets"`
}
type Config struct {
	Consumer     consumer.Config
	Connectivity connectivity.Config
	Policy       Policy
}
type Host struct {
	Consumer *consumer.Client
	network  *connectivity.Client
	policy   Policy
	ops      []Operation
	mu       sync.Mutex
	current  *Session
}
type Session struct {
	native     *omniaauth.Session
	connection *connectivity.Session
	cancel     context.CancelFunc
}

func New(c Config) (*Host, error) {
	account, err := consumer.New(c.Consumer)
	if err != nil {
		return nil, err
	}
	c.Connectivity.Sessions = consumer.SessionProvider{Client: account}
	network, err := connectivity.New(c.Connectivity)
	if err != nil {
		return nil, err
	}
	var ops []Operation
	if err = json.Unmarshal(inventory, &ops); err != nil {
		return nil, err
	}
	ops = append(ops, managementOperations()...)
	ops = append(ops, brainstormOperations()...)
	compileOperations(ops)
	return &Host{Consumer: account, network: network, policy: c.Policy, ops: ops}, nil
}
func managementOperations() []Operation {
	var ops []Operation
	_ = json.Unmarshal(applicationInventory, &ops)
	return ops
}
func brainstormOperations() []Operation {
	var ops []Operation
	_ = json.Unmarshal(brainstormInventory, &ops)
	return ops
}
func compileOperations(ops []Operation) {
	for i := range ops {
		pattern := regexp.QuoteMeta(ops[i].Path)
		pattern = regexp.MustCompile(`\\\{[^}]+\\\}`).ReplaceAllStringFunc(pattern, func(part string) string {
			if strings.Contains(part, "file_path") {
				return `.+`
			}
			return `[^/]+`
		})
		ops[i].matcher = regexp.MustCompile("^" + pattern + "$")
	}
}

// CatalogPolicy is also used by the local HTTP adapter; it grants no server role.
func CatalogPolicy(policy Policy) *Host {
	var ops []Operation
	_ = json.Unmarshal(inventory, &ops)
	ops = append(ops, managementOperations()...)
	ops = append(ops, brainstormOperations()...)
	compileOperations(ops)
	return &Host{policy: policy, ops: ops}
}
func (h *Host) Authorize(method, path string) error {
	u, err := url.Parse(path)
	if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" || u.User != nil || strings.ContainsAny(path, "\\\r\n\x00") {
		return errors.New("INVALID_REQUEST")
	}
	for _, part := range strings.Split(u.Path, "/") {
		if part == "." || part == ".." {
			return errors.New("INVALID_REQUEST")
		}
	}
	for _, op := range h.ops {
		if op.Method == method && op.matcher.MatchString(u.Path) {
			if !contains(h.policy.Operations, op.ID) {
				return errors.New("OPERATION_NOT_ALLOWED")
			}
			if strings.HasPrefix(u.Path, "/api/agents/") && strings.Contains(op.Path, "{agent_id}") {
				id := strings.Split(strings.TrimPrefix(u.Path, "/api/agents/"), "/")[0]
				if h.policy.Agents != nil && !contains(h.policy.Agents, id) {
					return errors.New("AGENT_NOT_ALLOWED")
				}
			}
			return nil
		}
	}
	return errors.New("UNKNOWN_OPERATION")
}
func contains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

// AuthorizeRequest also scopes legacy agent selection carried in a header.
func (h *Host) AuthorizeRequest(method, path string, headers http.Header) error {
	if err := h.Authorize(method, path); err != nil {
		return err
	}
	id := headers.Get("X-Octop-Agent-Id")
	if id == "" {
		return nil
	}
	u, _ := url.Parse(path)
	for _, op := range h.ops {
		if op.Method != method || !op.matcher.MatchString(u.Path) {
			continue
		}
		for _, p := range op.Parameters {
			if p.In == "header" && strings.EqualFold(p.Name, "X-Octop-Agent-Id") {
				if h.policy.Agents != nil && !contains(h.policy.Agents, id) {
					return errors.New("AGENT_NOT_ALLOWED")
				}
				return nil
			}
		}
	}
	return errors.New("INVALID_REQUEST")
}
func (h *Host) Connect(ctx context.Context, deviceID string, username, password string) (*Session, error) {
	// The supplied platform currently approves only this existing binding. Never
	// silently borrow it on behalf of another registered application.
	if h.policy.ApplicationID != "omnia-desktop" {
		return nil, errors.New("APPLICATION_CONTRACT_NOT_SUPPORTED")
	}
	h.Disconnect()
	connection, err := h.network.Connect(ctx, connectivity.OmniaBinding(deviceID))
	if err != nil {
		return nil, err
	}
	config := omniaauth.Config{Consumer: h.Consumer, Connection: connection}
	var auth *omniaauth.Session
	if username != "" {
		auth, err = omniaauth.LinkExisting(ctx, config, username, password)
	} else {
		auth, err = omniaauth.Login(ctx, config)
	}
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	life, cancel := context.WithCancel(context.Background())
	session := &Session{native: auth, connection: connection, cancel: cancel}
	h.mu.Lock()
	h.current = session
	h.mu.Unlock()
	go func() {
		for {
			delay := time.Until(auth.ExpiresAt()) - 30*time.Second
			if delay < time.Second {
				delay = time.Second
			}
			timer := time.NewTimer(delay)
			select {
			case <-life.Done():
				timer.Stop()
				return
			case <-auth.Done():
				timer.Stop()
				_ = connection.Close()
				return
			case <-connection.Done():
				timer.Stop()
				_ = auth.Close()
				return
			case <-timer.C:
			}
			refreshCtx, stop := context.WithTimeout(life, 20*time.Second)
			e := auth.Refresh(refreshCtx)
			stop()
			if e != nil {
				_ = auth.Close()
				_ = connection.Close()
				return
			}
		}
	}()
	return session, nil
}
func (h *Host) Session() (*Session, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.current == nil || !h.current.native.Active() {
		return nil, errors.New("NOT_CONNECTED")
	}
	return h.current, nil
}
func (s *Session) User() omniaauth.User                    { return s.native.User() }
func (s *Session) Done() <-chan struct{}                   { return s.native.Done() }
func (s *Session) ExpiresAt() time.Time                    { return s.native.ExpiresAt() }
func (s *Session) Capabilities() connectivity.Capabilities { return s.connection.Capabilities() }
func (s *Session) InitializeOwner(ctx context.Context, proof string) error {
	return s.native.InitializeOwner(ctx, proof)
}
func (h *Host) Request(ctx context.Context, method, path string, headers http.Header, body io.Reader) (*http.Response, error) {
	if err := h.AuthorizeRequest(method, path, headers); err != nil {
		return nil, err
	}
	session, err := h.Session()
	if err != nil {
		return nil, err
	}
	return session.native.OpenHTTPStream(ctx, connectivity.RelativeRequest{Method: method, Path: path, Headers: headers, Body: body})
}

var socketPaths = map[string]*regexp.Regexp{
	"chat": regexp.MustCompile(`^/api/agents/([^/]+)/chat/ws$`), "terminal": regexp.MustCompile(`^/api/agents/([^/]+)/terminal/ws$`),
	"notifications": regexp.MustCompile(`^/api/notifications/ws$`), "browser-stream": regexp.MustCompile(`^/api/browser-stream/ws$`),
	"desktop-stream": regexp.MustCompile(`^/api/desktop-stream/ws$`), "mobile-stream": regexp.MustCompile(`^/api/mobile-stream/ws$`), "mobile-adb-shell": regexp.MustCompile(`^/api/mobile/adb/shell/ws$`),
}

func (h *Host) OpenSocket(ctx context.Context, endpoint, path string) (*omniaauth.MessageStream, error) {
	u, err := url.Parse(path)
	if err != nil {
		return nil, errors.New("INVALID_REQUEST")
	}
	pattern := socketPaths[endpoint]
	if pattern == nil || !pattern.MatchString(u.Path) || !contains(h.policy.Sockets, endpoint) {
		return nil, errors.New("SOCKET_NOT_ALLOWED")
	}
	match := pattern.FindStringSubmatch(u.Path)
	if len(match) > 1 && h.policy.Agents != nil && !contains(h.policy.Agents, match[1]) {
		return nil, errors.New("AGENT_NOT_ALLOWED")
	}
	session, err := h.Session()
	if err != nil {
		return nil, err
	}
	return session.native.OpenMessageStream(ctx, connectivity.MessageStreamRequest{Path: path})
}
func (h *Host) Disconnect() {
	h.mu.Lock()
	s := h.current
	h.current = nil
	h.mu.Unlock()
	if s != nil {
		s.cancel()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = s.native.Logout(ctx)
		cancel()
		_ = s.native.Close()
		_ = s.connection.Close()
	}
}
func (h *Host) Close() error { h.Disconnect(); return h.network.Close() }

// SafeCode never exposes upstream URLs, bodies, keys or credentials.
func SafeCode(err error) string {
	if err == nil {
		return ""
	}
	if c := omniaauth.ErrorCode(err); c != "" {
		return c
	}
	if c := connectivity.ErrorCode(err); c != "" {
		return c
	}
	var c *consumer.Error
	if errors.As(err, &c) {
		return c.Kind
	}
	switch err.Error() {
	case "INVALID_REQUEST", "OPERATION_NOT_ALLOWED", "AGENT_NOT_ALLOWED", "UNKNOWN_OPERATION", "APPLICATION_CONTRACT_NOT_SUPPORTED", "NOT_CONNECTED", "SOCKET_NOT_ALLOWED":
		return err.Error()
	}
	if errors.Is(err, context.Canceled) {
		return "CANCELLED"
	}
	return "NATIVE_HOST_ERROR"
}
