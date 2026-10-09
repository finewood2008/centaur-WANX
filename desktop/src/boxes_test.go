package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBoxURLContract(t *testing.T) {
	for _, raw := range []string{"http://192.168.1.2", "https://user:pass@box.test", "https://box.test/api", "https://box.test?", "https://box.test?token=secret", "https://box.test/#identity", "file:///tmp/box"} {
		if _, err := normalizeBoxURL(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, raw := range []string{"https://box.test:8443/", "http://127.0.0.1:8088", "http://[::1]:8088"} {
		if _, err := normalizeBoxURL(raw); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBoxProbeRequiresWANXHealthAndRejectsRedirect(t *testing.T) {
	for _, body := range []string{`{"ok":true}`, `{"ok":false}`, `<html>not a WANX service</html>`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/health" {
				t.Errorf("unexpected path %s", r.URL.Path)
			}
			w.Write([]byte(body))
		}))
		err := probeBox(context.Background(), server.URL)
		server.Close()
		if (err == nil) != (body == `{"ok":true}`) {
			t.Fatalf("health %s => %v", body, err)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://other.test", 302) }))
	defer server.Close()
	if probeBox(context.Background(), server.URL) == nil {
		t.Fatal("redirect accepted")
	}
}

func TestSwitchCancelsPendingConnectionAndStoresNoCredential(t *testing.T) {
	t.Setenv("OCTOP_HOME", t.TempDir())
	app := &App{store: &settingsStore{cur: defaultSettings()}}
	ctx, cancel := context.WithCancel(context.Background())
	app.boxCancel = cancel
	app.ShowBoxes()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("switch did not cancel pending connection")
	}
	if err := app.SaveBoxes([]BoxAddress{{Name: "Synthetic", URL: "http://127.0.0.1:8897/"}}); err != nil {
		t.Fatal(err)
	}
	if got := loadSettings().Boxes; len(got) != 1 || got[0].URL != "http://127.0.0.1:8897" {
		t.Fatalf("round trip %#v", got)
	}
	if err := app.SaveBoxes([]BoxAddress{{Name: "Bad", URL: "https://user:secret@box.test"}}); err == nil {
		t.Fatal("stored credentials")
	}
}
