package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/netbirdio/netbird/client/embed"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type peerInfo struct {
	IP        string `json:"ip"`
	Name      string `json:"name"`
	Connected bool   `json:"connected"`
}
type networkStatus struct {
	Phase  string     `json:"phase"`
	Reason *string    `json:"reason"`
	Peers  []peerInfo `json:"peers"`
}

func state(phase, reason string) networkStatus {
	s := networkStatus{Phase: phase, Peers: []peerInfo{}}
	if reason != "" {
		s.Reason = &reason
	}
	return s
}

type startParams struct {
	ManagementURL string `json:"managementURL"`
	ConfigDir     string `json:"configDir"`
	DeviceName    string `json:"deviceName"`
	SetupKey      string `json:"setupKey"`
}
type engine interface {
	Start(context.Context) error
	Stop(context.Context) error
	Status() networkStatus
	Allowed(netip.Addr) bool
	DialContext(context.Context, string, string) (net.Conn, error)
}
type engineFactory func(startParams, string) (engine, error)
type embeddedEngine struct{ client *embed.Client }

func validateParams(p startParams) error {
	u, err := url.Parse(p.ManagementURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || !filepath.IsAbs(p.ConfigDir) || p.DeviceName == "" || len(p.DeviceName) > 128 {
		return failure("invalid_params")
	}
	return nil
}

func managementAddress(u *url.URL) string {
	port := u.Port()
	if port == "" {
		port = "443"
	}
	return net.JoinHostPort(strings.ToLower(u.Hostname()), port)
}

// This directory belongs exclusively to Wanx. Never load the system client's
// keys. Refuse symlinks so chmod and NetBird's atomic writes cannot escape it.
func secureConfigDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return failure("config_failed")
	}
	i, err := os.Lstat(dir)
	if err != nil || !i.IsDir() || i.Mode()&os.ModeSymlink != 0 {
		return failure("config_failed")
	}
	if os.Chmod(dir, 0700) != nil {
		return failure("config_failed")
	}
	for _, name := range []string{"config.json", "state.json"} {
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || os.Chmod(path, 0600) != nil {
			return failure("config_failed")
		}
	}
	return nil
}

func newEmbeddedEngine(p startParams, jwt string) (engine, error) {
	if err := validateParams(p); err != nil {
		return nil, err
	}
	if err := secureConfigDir(p.ConfigDir); err != nil {
		return nil, err
	}
	configPath := filepath.Join(p.ConfigDir, "config.json")
	port := 0
	lazy := false
	opts := embed.Options{DeviceName: p.DeviceName, ManagementURL: p.ManagementURL, ConfigPath: configPath, StatePath: filepath.Join(p.ConfigDir, "state.json"), NoUserspace: false, DisableClientRoutes: true, DisableIPv6: true, BlockInbound: true, BlockLANAccess: true, WireguardPort: &port, LazyConnectionEnabled: &lazy, LogOutput: io.Discard, LogLevel: "panic"}
	if p.SetupKey != "" {
		opts.SetupKey = p.SetupKey
	} else if jwt != "" {
		opts.JWTToken = jwt
	} else {
		data, err := os.ReadFile(configPath)
		if os.IsNotExist(err) {
			return nil, failure("auth_required")
		}
		if err != nil {
			return nil, failure("config_failed")
		}
		var saved struct {
			PrivateKey    string
			ManagementURL *url.URL
		}
		if json.Unmarshal(data, &saved) != nil || saved.PrivateKey == "" {
			return nil, failure("config_failed")
		}
		// NetBird serializes url.URL as an object. Do not reuse a peer identity
		// against a different control plane after changing settings.
		requested, _ := url.Parse(p.ManagementURL)
		if saved.ManagementURL == nil || saved.ManagementURL.Scheme != "https" || managementAddress(saved.ManagementURL) != managementAddress(requested) {
			return nil, failure("auth_required")
		}
		opts.PrivateKey = saved.PrivateKey
	}
	c, err := embed.New(opts)
	if err != nil {
		return nil, failure("config_failed")
	}
	if err := secureConfigDir(p.ConfigDir); err != nil {
		return nil, err
	}
	return &embeddedEngine{client: c}, nil
}
func (e *embeddedEngine) Start(ctx context.Context) error {
	err := e.client.Start(ctx)
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return failure("cancelled")
	}
	code := status.Code(err)
	if code == codes.Unauthenticated || code == codes.PermissionDenied || strings.Contains(strings.ToLower(err.Error()), "login required") {
		return failure("auth_required")
	}
	return failure("start_failed")
}
func (e *embeddedEngine) Stop(ctx context.Context) error { return e.client.Stop(ctx) }
func (e *embeddedEngine) Status() networkStatus {
	s, err := e.client.Status()
	if err != nil {
		return state("error", "network_unavailable")
	}
	out := state("ready", "")
	if !s.ManagementState.Connected || !s.SignalState.Connected {
		out = state("error", "network_unavailable")
	}
	for _, p := range s.Peers {
		ip, err := netip.ParseAddr(p.IP)
		if err != nil {
			continue
		}
		out.Peers = append(out.Peers, peerInfo{IP: ip.String(), Name: p.FQDN, Connected: p.ConnStatus == embed.PeerStatusConnected})
	}
	return out
}
func (e *embeddedEngine) Allowed(ip netip.Addr) bool {
	_, _, ok := e.client.IdentityForIP(ip)
	return ok
}
func (e *embeddedEngine) DialContext(ctx context.Context, n, a string) (net.Conn, error) {
	return e.client.DialContext(ctx, n, a)
}
