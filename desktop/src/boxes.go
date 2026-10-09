package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/wailsapp/wails/v3/pkg/application"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Addresses are client-owned connection hints, never verified device identities.
type BoxAddress struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

func normalizeBoxURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("invalid box URL")
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if (u.Scheme != "https" && !(u.Scheme == "http" && loopback)) || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("use a trusted HTTPS origin without credentials, query or path; HTTP is limited to loopback")
	}
	return u.Scheme + "://" + u.Host, nil
}

func (a *App) SaveBoxes(boxes []BoxAddress) error {
	for i := range boxes {
		base, err := normalizeBoxURL(boxes[i].URL)
		if err != nil {
			return err
		}
		boxes[i].URL = base
		boxes[i].Name = strings.TrimSpace(boxes[i].Name)
		if boxes[i].Name == "" || len(boxes[i].Name) > 240 {
			return fmt.Errorf("invalid box name")
		}
	}
	next := a.store.get()
	next.Boxes = append([]BoxAddress(nil), boxes...)
	return a.store.save(next)
}

func (a *App) cancelBoxConnection() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.boxGeneration++
	if a.boxCancel != nil {
		a.boxCancel()
		a.boxCancel = nil
	}
}

func (a *App) ShowBoxes() {
	a.cancelBoxConnection()
	a.mu.Lock()
	cmd := a.cmd
	a.cmd = nil
	a.mu.Unlock()
	stopOctop(cmd)
	if a.window == nil {
		return
	}
	// Drop old authenticated React state and stop streams before changing origin.
	a.window.ExecJS(`window.dispatchEvent(new Event('wanx:leave-box')); try{localStorage.removeItem('auth_token');sessionStorage.removeItem('auth_token');localStorage.removeItem('octop:active-agent');}catch(e){}`)
	a.window.SetURL("/?boxes=1")
	a.showWindow()
}

func probeBox(ctx context.Context, base string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/health", nil)
	if err != nil {
		return err
	}
	// No redirects: a connection check must not silently select another box.
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var health struct {
		OK bool `json:"ok"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&health) != nil || !health.OK {
		return fmt.Errorf("WANX health check failed (%d)", response.StatusCode)
	}
	return nil
}

func (a *App) ConnectBox(raw string) error {
	base, err := normalizeBoxURL(raw)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a.mu.Lock()
	if a.boxCancel != nil {
		a.boxCancel()
	}
	a.boxGeneration++
	generation := a.boxGeneration
	a.boxCancel = cancel
	a.mu.Unlock()
	if err := probeBox(ctx, base); err != nil {
		return err
	}
	active := false
	commit := func() {
		a.mu.Lock()
		active = a.boxGeneration == generation && ctx.Err() == nil
		a.mu.Unlock()
		if active && a.window != nil {
			a.showDashboard(base + "/boxes?wanx_client=remote")
		}
	}
	if a.app != nil {
		application.InvokeSync(commit)
	} else {
		commit()
	}
	if !active {
		return context.Canceled
	}
	next := a.store.get()
	next.ConnectionMode = "box"
	if err := a.store.save(next); err != nil {
		return err
	}
	return nil
}

// Kept as an explicit legacy option, rather than starting a server on every laptop.
func (a *App) StartLocal() error {
	a.cancelBoxConnection()
	next := a.store.get()
	next.ConnectionMode = "local"
	if err := a.store.save(next); err != nil {
		return err
	}
	if a.window != nil {
		a.window.SetURL("/")
	}
	go a.boot()
	return nil
}
