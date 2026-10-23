package main

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

type service struct {
	mu             sync.Mutex
	factory        engineFactory
	engine         engine
	proxy          *tunnelProxy
	cancel         context.CancelFunc
	epoch          uint64
	starting       bool
	pendingStart   bool
	login          *deviceLogin
	jwt            string
	authManagement string
	activeParams   startParams
	statusValue    networkStatus
	statusAt       time.Time
	statusStop     chan struct{}
}

func newService(factory engineFactory) *service { return &service{factory: factory} }
func (s *service) dispatch(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	var p startParams
	if method == "start" || method == "login_begin" {
		if json.Unmarshal(raw, &p) != nil {
			return nil, failure("invalid_params")
		}
		if err := validateParams(p); err != nil {
			return nil, err
		}
	}
	switch method {
	case "start":
		return s.start(ctx, p)
	case "recover":
		return s.recover(ctx)
	case "status":
		return s.status(), nil
	case "stop":
		s.stop()
		return state("disabled", ""), nil
	case "login_begin":
		return s.beginLogin(ctx, p)
	case "login_wait":
		return s.waitLogin(ctx)
	default:
		return nil, failure("unknown_method")
	}
}

// The SDK Status call runs STUN/TURN probes (up to 1.3s), not just a local
// recorder read. One sampler owns that I/O; UI status reads stay local. Expired
// observations must never keep advertising old peers as connected.
const statusSampleInterval = time.Second
const statusMaxAge = 3 * time.Second

func cloneStatus(value networkStatus) networkStatus {
	value.Peers = append([]peerInfo{}, value.Peers...)
	return value
}
func (s *service) invalidateStatusLocked() {
	if s.statusStop != nil {
		close(s.statusStop)
		s.statusStop = nil
	}
	s.statusValue = networkStatus{}
	s.statusAt = time.Time{}
}
func (s *service) status() networkStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proxy != nil && (s.starting || s.engine == nil) {
		return state("recovering", "network_unavailable")
	}
	if s.starting {
		return state("starting", "")
	}
	if s.engine == nil {
		return state("disabled", "")
	}
	if s.statusAt.IsZero() || time.Since(s.statusAt) >= statusMaxAge {
		return state("recovering", "network_unavailable")
	}
	return cloneStatus(s.statusValue)
}
func (s *service) sampleStatus(e engine, epoch uint64) networkStatus {
	// The initial observation is real: successful Start alone does not establish
	// control-plane or peer health. Later refreshes reuse only bounded observations.
	value := e.Status()
	s.mu.Lock()
	if s.epoch != epoch || s.engine != e {
		s.mu.Unlock()
		return state("disabled", "")
	}
	s.statusValue, s.statusAt = cloneStatus(value), time.Now()
	stop := make(chan struct{})
	s.statusStop = stop
	s.mu.Unlock()
	go func() {
		timer := time.NewTimer(statusSampleInterval)
		defer timer.Stop()
		for {
			select {
			case <-stop:
				return
			case <-timer.C:
			}
			next := e.Status()
			s.mu.Lock()
			if s.epoch != epoch || s.engine != e {
				s.mu.Unlock()
				return
			}
			s.statusValue, s.statusAt = cloneStatus(next), time.Now()
			s.mu.Unlock()
			timer.Reset(statusSampleInterval)
		}
	}()
	return value
}
func (s *service) start(parent context.Context, p startParams) (any, error) {
	s.mu.Lock()
	if s.engine != nil && s.activeParams.ManagementURL == p.ManagementURL && s.activeParams.ConfigDir == p.ConfigDir && s.activeParams.DeviceName == p.DeviceName {
		proxy := s.proxy
		s.mu.Unlock()
		return struct {
			Proxy  proxyInfo     `json:"proxy"`
			Status networkStatus `json:"status"`
		}{proxy.info, s.status()}, nil
	}
	if s.pendingStart || s.engine != nil {
		s.mu.Unlock()
		return nil, failure("busy")
	}
	s.epoch++
	epoch := s.epoch
	if s.cancel != nil {
		s.cancel()
	}
	if s.login != nil {
		s.login.cancel()
		s.login = nil
	}
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	s.cancel = cancel
	s.starting = true
	s.pendingStart = true
	jwt := ""
	if s.authManagement == p.ManagementURL {
		jwt = s.jwt
	}
	s.jwt = ""
	s.mu.Unlock()
	defer cancel()
	defer func() { s.mu.Lock(); s.pendingStart = false; s.mu.Unlock() }()
	e, err := s.factory(p, jwt)
	if err == nil {
		err = e.Start(ctx)
	}
	var proxy *tunnelProxy
	if err == nil && ctx.Err() == nil {
		proxy, err = newProxy(e)
	}
	s.mu.Lock()
	current := s.epoch == epoch
	if !current || ctx.Err() != nil {
		err = failure("cancelled")
	}
	if current {
		s.starting = false
		s.cancel = nil
		if err == nil {
			s.engine = e
			s.proxy = proxy
			s.activeParams = p
			s.activeParams.SetupKey = ""
		}
	}
	s.mu.Unlock()
	if err != nil {
		if proxy != nil {
			proxy.close()
		}
		if e != nil {
			stopEngine(e)
		}
		return nil, err
	}
	return struct {
		Proxy  proxyInfo     `json:"proxy"`
		Status networkStatus `json:"status"`
	}{proxy.info, s.sampleStatus(e, epoch)}, nil
}

// Recovery reuses the saved peer identity and local proxy. It never consumes
// another enrollment key or closes the application's box login session.
func (s *service) recover(parent context.Context) (any, error) {
	s.mu.Lock()
	if s.pendingStart {
		s.mu.Unlock()
		return nil, failure("busy")
	}
	if s.proxy == nil {
		s.mu.Unlock()
		return nil, failure("network_unavailable")
	}
	s.epoch++
	epoch := s.epoch
	previous, proxy, p := s.engine, s.proxy, s.activeParams
	s.invalidateStatusLocked()
	s.engine = nil
	s.starting, s.pendingStart = true, true
	ctx, cancel := context.WithTimeout(parent, 40*time.Second)
	s.cancel = cancel
	proxy.replaceEngine(nil)
	s.mu.Unlock()
	defer cancel()
	defer func() { s.mu.Lock(); s.pendingStart = false; s.mu.Unlock() }()
	if previous != nil {
		stopEngine(previous)
	}
	var e engine
	var err error
	if ctx.Err() == nil {
		e, err = s.factory(p, "")
	}
	if e != nil && err == nil {
		err = e.Start(ctx)
	}
	s.mu.Lock()
	current := s.epoch == epoch
	if !current || ctx.Err() == context.Canceled {
		err = failure("cancelled")
	} else if ctx.Err() == context.DeadlineExceeded && (err == nil || err.Error() != "auth_required") {
		// A slow/offline network is retryable. Only an explicit stop or parent
		// cancellation invalidates the retained gateway; auth denial still wins.
		err = failure("start_failed")
	}
	if current {
		s.starting = false
		s.cancel = nil
		if err == nil {
			s.engine = e
			proxy.replaceEngine(e)
		}
	}
	s.mu.Unlock()
	if err != nil {
		if e != nil {
			stopEngine(e)
		}
		return nil, err
	}
	return struct {
		Proxy  proxyInfo     `json:"proxy"`
		Status networkStatus `json:"status"`
	}{proxy.info, s.sampleStatus(e, epoch)}, nil
}
func stopEngine(e engine) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = e.Stop(ctx)
}
func (s *service) stop() {
	s.mu.Lock()
	s.epoch++
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	if s.login != nil {
		s.login.cancel()
		s.login = nil
	}
	e, proxy := s.engine, s.proxy
	s.invalidateStatusLocked()
	s.engine = nil
	s.proxy = nil
	s.starting = false
	s.jwt = ""
	s.authManagement = ""
	s.activeParams = startParams{}
	s.mu.Unlock()
	if proxy != nil {
		proxy.close()
	}
	if e != nil {
		stopEngine(e)
	}
}

func (s *service) beginLogin(parent context.Context, p startParams) (any, error) {
	s.mu.Lock()
	if s.pendingStart || s.engine != nil {
		s.mu.Unlock()
		return nil, failure("busy")
	}
	s.epoch++
	epoch := s.epoch
	if s.cancel != nil {
		s.cancel()
	}
	if s.login != nil {
		s.login.cancel()
		s.login = nil
	}
	ctx, cancel := context.WithCancel(parent)
	s.cancel = cancel
	s.jwt = ""
	s.mu.Unlock()
	login, err := requestDeviceLogin(ctx, p.ManagementURL)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.epoch != epoch {
		cancel()
		return nil, failure("cancelled")
	}
	if err != nil {
		cancel()
		s.cancel = nil
		return nil, err
	}
	login.cancel = cancel
	s.login = login
	s.authManagement = p.ManagementURL
	return login.public, nil
}
func (s *service) waitLogin(parent context.Context) (any, error) {
	s.mu.Lock()
	login := s.login
	epoch := s.epoch
	if login == nil {
		s.mu.Unlock()
		return nil, failure("auth_required")
	}
	if login.waiting {
		s.mu.Unlock()
		return nil, failure("busy")
	}
	login.waiting = true
	s.mu.Unlock()
	token, err := login.wait(parent)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.epoch != epoch {
		return nil, failure("cancelled")
	}
	s.login = nil
	s.cancel = nil
	login.cancel()
	if err != nil {
		return nil, err
	}
	s.jwt = token
	return map[string]bool{"authenticated": true}, nil
}
