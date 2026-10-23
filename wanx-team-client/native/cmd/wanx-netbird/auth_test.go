package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func testJWT(aud string) string {
	return "header." + base64.RawURLEncoding.EncodeToString([]byte(`{"aud":"`+aud+`"}`)) + ".signature"
}
func TestDeviceLoginPollsPendingAndRetainsTokenOnlyInNative(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ParseForm() != nil || r.Form.Get("device_code") != "private-device-code" || r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" {
			t.Error("invalid device grant")
		}
		if calls.Add(1) == 1 {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]string{"error": "authorization_pending"})
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"access_token": testJWT("wanx"), "refresh_token": "never-save"})
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d := &deviceLogin{ctx: ctx, cancel: cancel, deviceCode: "private-device-code", clientID: "client", audience: "wanx", tokenEndpoint: server.URL, interval: time.Millisecond, expires: time.Now().Add(time.Second), http: server.Client()}
	s := newService(nil)
	s.login = d
	result, err := s.waitLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if string(encoded) != "{\"authenticated\":true}" {
		t.Fatal("credentials leaked in response")
	}
	if s.jwt != testJWT("wanx") || s.login != nil || calls.Load() != 2 {
		t.Fatal("login not completed correctly")
	}
	s.stop()
	if s.jwt != "" {
		t.Fatal("token survived stop")
	}
}
func TestDeviceLoginCancellationAndExpiry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	d := &deviceLogin{ctx: ctx, interval: time.Hour, expires: time.Now().Add(time.Hour)}
	if _, err := d.wait(context.Background()); err == nil || err.Error() != "cancelled" {
		t.Fatal(err)
	}
	d.ctx = context.Background()
	d.expires = time.Now().Add(-time.Second)
	if _, err := d.wait(context.Background()); err == nil || err.Error() != "auth_expired" {
		t.Fatal(err)
	}
}
func TestDeviceLoginRejectsWrongAudience(t *testing.T) {
	if tokenAudienceMatches(testJWT("other"), "wanx") || tokenAudienceMatches("not-a-jwt", "wanx") || !tokenAudienceMatches(testJWT("wanx"), "wanx") {
		t.Fatal("audience validation failed")
	}
}
