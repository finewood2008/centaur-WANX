package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"centaurai-wanx/native/wanx"
	"codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git/go/connectivity"
	"codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git/go/consumer"
	"codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git/go/omniaauth"
)

const version = "0.1.0-wanx.1"

type message struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Reply  string          `json:"reply"`
	Error  string          `json:"error"`
}
type identity struct {
	ClientID    string `json:"clientId"`
	PrivateKey  string `json:"privateKeyPEM"`
	PublicKey   string `json:"publicKeyPEM"`
	Platform    string `json:"platform"`
	DeviceModel string `json:"deviceModel"`
}
type params struct {
	BaseURL      string               `json:"consumerBaseURL"`
	LocalBaseURL string               `json:"localBaseURL"`
	LocalToken   string               `json:"localToken"`
	Gateway      []string             `json:"trustedGatewayHosts"`
	ICE          []string             `json:"trustedICEHosts"`
	Identity     identity             `json:"identity"`
	Session      consumer.AuthSession `json:"session"`
	Policy       wanx.Policy          `json:"policy"`
	Phone        string               `json:"phone"`
	Password     string               `json:"password"`
	Code         string               `json:"code"`
	DeviceID     string               `json:"deviceId"`
	Username     string               `json:"username"`
	WizardToken  string               `json:"wizardToken"`
	Method       string               `json:"method"`
	Path         string               `json:"path"`
	Headers      map[string]string    `json:"headers"`
	Body         string               `json:"body"`
	Handle       string               `json:"handle"`
	Kind         string               `json:"kind"`
	Text         string               `json:"text"`
	Endpoint     string               `json:"endpoint"`
	CloseCode    int                  `json:"closeCode"`
	Reason       string               `json:"reason"`
	RequestID    string               `json:"requestId"`
}
type peer struct {
	writeMu                  sync.Mutex
	mu                       sync.Mutex
	controlMu                sync.Mutex
	counter                  atomic.Uint64
	host                     *wanx.Host
	policy                   *wanx.Host
	store                    *store
	identity                 identity
	localBaseURL, localToken string
	streams                  map[string]io.ReadCloser
	sockets                  map[string]*omniaauth.MessageStream
	pending                  map[string]context.CancelFunc
	callbacks                map[string]chan string
}

func newPeer() *peer {
	return &peer{streams: map[string]io.ReadCloser{}, sockets: map[string]*omniaauth.MessageStream{}, pending: map[string]context.CancelFunc{}, callbacks: map[string]chan string{}}
}
func (p *peer) emit(v any) {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(v)
}
func (p *peer) next() string { return fmt.Sprint(p.counter.Add(1)) }
func (p *peer) callback(method string, value any) error {
	id := "store-" + p.next()
	done := make(chan string, 1)
	p.mu.Lock()
	p.callbacks[id] = done
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.callbacks, id); p.mu.Unlock() }()
	p.emit(map[string]any{"callback": method, "id": id, "value": value})
	select {
	case failure := <-done:
		if failure != "" {
			return errors.New("SECURE_STORAGE_FAILED")
		}
		return nil
	case <-time.After(10 * time.Second):
		return errors.New("SECURE_STORAGE_FAILED")
	}
}

type store struct {
	mu      sync.Mutex
	session consumer.AuthSession
	peer    *peer
}

func (s *store) Load() (consumer.AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.session, nil
}
func (s *store) Save(v consumer.AuthSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.peer.callback("session.save", v); err != nil {
		return err
	}
	s.session = v
	return nil
}
func (s *store) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.session = consumer.AuthSession{}
	return s.peer.callback("session.clear", nil)
}
func (p *peer) initialize(v params) error {
	if p.policy != nil {
		return errors.New("ALREADY_INITIALIZED")
	}
	if v.LocalBaseURL != "" {
		u, err := url.Parse(v.LocalBaseURL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"))) {
			return errors.New("INVALID_CONFIG")
		}
		p.localBaseURL = strings.TrimRight(v.LocalBaseURL, "/")
		p.localToken = v.LocalToken
		p.policy = wanx.CatalogPolicy(v.Policy)
		return nil
	}
	block, _ := pem.Decode([]byte(v.Identity.PrivateKey))
	if block == nil {
		return errors.New("INVALID_IDENTITY")
	}
	raw, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return errors.New("INVALID_IDENTITY")
	}
	key, ok := raw.(*ecdsa.PrivateKey)
	if !ok || key.Curve.Params().Name != "P-256" {
		return errors.New("INVALID_IDENTITY")
	}
	p.identity = v.Identity
	p.store = &store{session: v.Session, peer: p}
	signer := consumer.NativeSigner{ClientID: v.Identity.ClientID, SignPayload: func(payload []byte) (string, error) {
		hash := sha256.Sum256(payload)
		signature, err := ecdsa.SignASN1(rand.Reader, key, hash[:])
		return base64.StdEncoding.EncodeToString(signature), err
	}}
	p.host, err = wanx.New(wanx.Config{Consumer: consumer.Config{BaseURL: v.BaseURL, Signer: signer, Store: p.store}, Connectivity: connectivity.Config{TrustedGatewayHosts: v.Gateway, TrustedICEHosts: v.ICE}, Policy: v.Policy})
	if err == nil {
		p.policy = wanx.CatalogPolicy(v.Policy)
	}
	return err
}
func (p *peer) clearStreams() {
	p.mu.Lock()
	streams := p.streams
	sockets := p.sockets
	p.streams = map[string]io.ReadCloser{}
	p.sockets = map[string]*omniaauth.MessageStream{}
	p.mu.Unlock()
	for _, r := range streams {
		_ = r.Close()
	}
	for _, s := range sockets {
		_ = s.Close(1000, "")
	}
}
func (p *peer) dispatch(ctx context.Context, method string, v params) (any, error) {
	switch method {
	case "version":
		return map[string]any{"name": "centaurai-wanx", "version": version, "goSdk": "0.2.0", "core": "0.1.1"}, nil
	case "initialize":
		p.controlMu.Lock()
		defer p.controlMu.Unlock()
		err := p.initialize(v)
		return map[string]string{"version": version}, err
	case "cancel":
		p.mu.Lock()
		cancel := p.pending[v.RequestID]
		p.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return nil, nil
	}
	if p.policy == nil {
		return nil, errors.New("NOT_INITIALIZED")
	}
	switch method {
	case "account.current":
		if p.store == nil {
			return nil, nil
		}
		s, _ := p.store.Load()
		if !s.Valid() {
			return nil, nil
		}
		return map[string]string{"accountId": s.AccountID, "clientId": s.ClientID}, nil
	case "account.sendSMS":
		if p.host == nil {
			return nil, errors.New("ACCOUNT_UNAVAILABLE")
		}
		result, err := p.host.Consumer.SendSMS(ctx, v.Phone)
		return map[string]int{"expiresIn": result.ExpiresIn}, err
	case "account.loginPassword", "account.loginSMS":
		if p.host == nil {
			return nil, errors.New("ACCOUNT_UNAVAILABLE")
		}
		p.controlMu.Lock()
		defer p.controlMu.Unlock()
		p.clearStreams()
		p.host.Disconnect()
		var s consumer.AuthSession
		var err error
		if method == "account.loginPassword" {
			s, err = p.host.Consumer.LoginPassword(ctx, consumer.PasswordLoginRequest{Phone: v.Phone, Password: v.Password, ClientID: p.identity.ClientID, ClientPublicKey: p.identity.PublicKey, Platform: p.identity.Platform, DeviceModel: p.identity.DeviceModel, DisplayName: "centaurai-wanx"})
		} else {
			s, err = p.host.Consumer.Login(ctx, consumer.LoginRequest{Phone: v.Phone, Code: v.Code, ClientID: p.identity.ClientID, ClientPublicKey: p.identity.PublicKey, Platform: p.identity.Platform, DeviceModel: p.identity.DeviceModel, DisplayName: "centaurai-wanx"})
		}
		if err != nil {
			return nil, err
		}
		return map[string]string{"accountId": s.AccountID, "clientId": s.ClientID}, nil
	case "devices.list":
		if p.host == nil {
			return nil, errors.New("ACCOUNT_UNAVAILABLE")
		}
		return p.host.Consumer.Devices(ctx)
	case "connection.connect":
		if p.host == nil {
			return nil, errors.New("ACCOUNT_UNAVAILABLE")
		}
		p.controlMu.Lock()
		defer p.controlMu.Unlock()
		p.clearStreams()
		s, err := p.host.Connect(ctx, v.DeviceID, v.Username, v.Password)
		if err != nil {
			return nil, err
		}
		cap := s.Capabilities()
		leaseID := p.next()
		go func() {
			<-s.Done()
			p.emit(map[string]any{"event": "connection.closed", "value": map[string]string{"leaseId": leaseID}})
		}()
		return map[string]any{"leaseId": leaseID, "user": s.User(), "nativeLeaseExpiresAt": s.ExpiresAt().UnixMilli(), "capabilities": map[string]any{"httpUnary": cap.HTTPUnary, "httpResponseStream": cap.HTTPResponseStream, "websocketMessages": cap.WebSocketMessages, "uploadStream": cap.UploadStream, "maxRequestBodyBytes": connectivity.MaxRequestBody, "networkPath": "direct"}}, nil
	case "connection.status":
		if p.host == nil {
			return map[string]any{"connected": p.localBaseURL != ""}, nil
		}
		s, err := p.host.Session()
		if err != nil {
			return map[string]bool{"connected": false}, nil
		}
		return map[string]any{"connected": true, "user": s.User(), "nativeLeaseExpiresAt": s.ExpiresAt().UnixMilli()}, nil
	case "connection.disconnect", "account.logout":
		p.controlMu.Lock()
		defer p.controlMu.Unlock()
		p.clearStreams()
		if p.host != nil {
			p.host.Disconnect()
			if method == "account.logout" {
				return nil, p.host.Consumer.Logout(ctx)
			}
		}
		return nil, nil
	case "owner.initialize":
		if p.host == nil {
			return nil, errors.New("NOT_CONNECTED")
		}
		s, err := p.host.Session()
		if err != nil {
			return nil, err
		}
		return nil, s.InitializeOwner(ctx, v.WizardToken)
	case "http.open":
		body, err := base64.StdEncoding.DecodeString(v.Body)
		if err != nil {
			return nil, errors.New("INVALID_REQUEST")
		}
		headers := http.Header{}
		for k, value := range v.Headers {
			if strings.EqualFold(k, "Authorization") || strings.EqualFold(k, "Cookie") {
				return nil, errors.New("INVALID_REQUEST")
			}
			headers.Set(k, value)
		}
		if err := p.policy.AuthorizeRequest(v.Method, v.Path, headers); err != nil {
			return nil, err
		}
		var resp *http.Response
		if p.localBaseURL != "" {
			request, e := http.NewRequestWithContext(ctx, v.Method, p.localBaseURL+v.Path, bytes.NewReader(body))
			if e != nil {
				return nil, e
			}
			request.Header = headers
			if p.localToken != "" {
				request.Header.Set("Authorization", "Bearer "+p.localToken)
			}
			client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			resp, err = client.Do(request)
		} else {
			resp, err = p.host.Request(ctx, v.Method, v.Path, headers, bytes.NewReader(body))
		}
		if err != nil {
			return nil, err
		}
		if ctx.Err() != nil {
			_ = resp.Body.Close()
			return nil, ctx.Err()
		}
		handle := p.next()
		p.mu.Lock()
		p.streams[handle] = resp.Body
		p.mu.Unlock()
		clean := map[string]string{}
		for k, values := range resp.Header {
			if strings.EqualFold(k, "Set-Cookie") || strings.EqualFold(k, "Authorization") {
				continue
			}
			clean[k] = strings.Join(values, ", ")
		}
		return map[string]any{"handle": handle, "status": resp.StatusCode, "headers": clean}, nil
	case "http.read":
		p.mu.Lock()
		reader := p.streams[v.Handle]
		p.mu.Unlock()
		if reader == nil {
			return nil, errors.New("STREAM_CLOSED")
		}
		b := make([]byte, 32768)
		n, err := reader.Read(b)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		return map[string]any{"body": base64.StdEncoding.EncodeToString(b[:n]), "done": errors.Is(err, io.EOF)}, nil
	case "http.close":
		p.mu.Lock()
		reader := p.streams[v.Handle]
		delete(p.streams, v.Handle)
		p.mu.Unlock()
		if reader != nil {
			_ = reader.Close()
		}
		return nil, nil
	case "socket.open":
		if p.host == nil {
			return nil, errors.New("SOCKET_UNAVAILABLE")
		}
		socket, err := p.host.OpenSocket(ctx, v.Endpoint, v.Path)
		if err != nil {
			return nil, err
		}
		handle := p.next()
		p.mu.Lock()
		p.sockets[handle] = socket
		p.mu.Unlock()
		return map[string]string{"handle": handle}, nil
	case "socket.read":
		p.mu.Lock()
		socket := p.sockets[v.Handle]
		p.mu.Unlock()
		if socket == nil {
			return nil, errors.New("STREAM_CLOSED")
		}
		frame, err := socket.Read(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{"kind": string(frame.Type), "body": base64.StdEncoding.EncodeToString(frame.Data)}, nil
	case "socket.write":
		p.mu.Lock()
		socket := p.sockets[v.Handle]
		p.mu.Unlock()
		if socket == nil {
			return nil, errors.New("STREAM_CLOSED")
		}
		body, err := base64.StdEncoding.DecodeString(v.Body)
		if err != nil {
			return nil, err
		}
		return nil, socket.Write(ctx, connectivity.Message{Type: connectivity.MessageType(v.Kind), Data: body})
	case "socket.close":
		p.mu.Lock()
		socket := p.sockets[v.Handle]
		delete(p.sockets, v.Handle)
		p.mu.Unlock()
		if socket != nil {
			code := v.CloseCode
			if code == 0 {
				code = 1000
			}
			return nil, socket.Close(code, v.Reason)
		}
		return nil, nil
	}
	return nil, errors.New("UNKNOWN_METHOD")
}
func main() {
	p := newPeer()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 8*1024*1024)
	for scanner.Scan() {
		var m message
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			continue
		}
		if m.Reply != "" {
			p.mu.Lock()
			ch := p.callbacks[m.Reply]
			p.mu.Unlock()
			if ch != nil {
				ch <- m.Error
			}
			continue
		}
		if m.ID == "" {
			continue
		}
		var v params
		if json.Unmarshal(m.Params, &v) != nil {
			p.emit(map[string]string{"id": m.ID, "error": "INVALID_REQUEST"})
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		p.mu.Lock()
		p.pending[m.ID] = cancel
		p.mu.Unlock()
		go func(m message, v params) {
			result, err := p.dispatch(ctx, m.Method, v)
			// HTTP/socket lifetimes are closed by explicit handles, not by the open RPC.
			if m.Method != "http.open" && m.Method != "socket.open" {
				cancel()
			}
			p.mu.Lock()
			delete(p.pending, m.ID)
			p.mu.Unlock()
			if err != nil {
				code := wanx.SafeCode(err)
				switch err.Error() {
				case "INVALID_CONFIG", "INVALID_IDENTITY", "ALREADY_INITIALIZED", "NOT_INITIALIZED", "ACCOUNT_UNAVAILABLE", "SOCKET_UNAVAILABLE", "STREAM_CLOSED", "UNKNOWN_METHOD":
					code = err.Error()
				}
				p.emit(map[string]string{"id": m.ID, "error": code})
			} else {
				p.emit(map[string]any{"id": m.ID, "result": result})
			}
		}(m, v)
	}
	p.clearStreams()
	if p.host != nil {
		_ = p.host.Close()
	}
}
