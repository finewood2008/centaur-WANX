package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	mgmt "github.com/netbirdio/netbird/shared/management/client"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

type publicLogin struct {
	VerificationURL string `json:"verificationURL"`
	UserCode        string `json:"userCode"`
	ExpiresIn       int    `json:"expiresIn"`
}
type deviceLogin struct {
	ctx                                           context.Context
	cancel                                        context.CancelFunc
	public                                        publicLogin
	deviceCode, clientID, audience, tokenEndpoint string
	useIDToken                                    bool
	interval                                      time.Duration
	expires                                       time.Time
	waiting                                       bool
	http                                          *http.Client
}

func validHTTPS(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == ""
}
func authHTTP() *http.Client {
	return &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func postForm(ctx context.Context, c *http.Client, endpoint string, form url.Values, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, failure("auth_failed")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.Do(req)
	if err != nil {
		return 0, failure("auth_failed")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 65537))
	if err != nil || len(data) > 65536 || json.Unmarshal(data, out) != nil {
		return resp.StatusCode, failure("auth_failed")
	}
	return resp.StatusCode, nil
}
func requestDeviceLogin(parent context.Context, managementURL string) (*deviceLogin, error) {
	ctx, cancel := context.WithTimeout(parent, 25*time.Second)
	defer cancel()
	u, _ := url.Parse(managementURL)
	key, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		return nil, failure("auth_failed")
	}
	// This public SDK call asks only for the deployment's OIDC metadata. It
	// does not register a peer or require a management API administrator key.
	c, err := mgmt.NewClient(ctx, managementAddress(u), key, true)
	if err != nil {
		return nil, failure("auth_failed")
	}
	defer c.Close()
	flow, err := c.GetDeviceAuthorizationFlow()
	if err != nil {
		return nil, failure("auth_unsupported")
	}
	provider := flow.GetProviderConfig()
	if provider == nil || provider.GetClientID() == "" || !validHTTPS(provider.GetTokenEndpoint()) || !validHTTPS(provider.GetDeviceAuthEndpoint()) {
		return nil, failure("auth_unsupported")
	}
	scope := provider.GetScope()
	if scope == "" {
		scope = "openid"
	}
	form := url.Values{"client_id": {provider.GetClientID()}, "audience": {provider.GetAudience()}, "scope": {scope}}
	var result struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresIn               int    `json:"expires_in"`
		Interval                int    `json:"interval"`
	}
	h := authHTTP()
	code, err := postForm(ctx, h, provider.GetDeviceAuthEndpoint(), form, &result)
	if err != nil || code != http.StatusOK {
		return nil, failure("auth_failed")
	}
	link := result.VerificationURIComplete
	if link == "" {
		link = result.VerificationURI
	}
	if !validHTTPS(link) || result.DeviceCode == "" || result.ExpiresIn <= 0 || result.ExpiresIn > 3600 {
		return nil, failure("auth_failed")
	}
	interval := result.Interval
	if interval < 1 {
		interval = 5
	}
	if interval > 60 {
		interval = 60
	}
	return &deviceLogin{ctx: parent, public: publicLogin{link, result.UserCode, result.ExpiresIn}, deviceCode: result.DeviceCode, clientID: provider.GetClientID(), audience: provider.GetAudience(), tokenEndpoint: provider.GetTokenEndpoint(), useIDToken: provider.GetUseIDToken(), interval: time.Duration(interval) * time.Second, expires: time.Now().Add(time.Duration(result.ExpiresIn) * time.Second), http: h}, nil
}
func (d *deviceLogin) wait(parent context.Context) (string, error) {
	ctx, cancel := context.WithDeadline(d.ctx, d.expires)
	defer cancel()
	stop := context.AfterFunc(parent, cancel)
	defer stop()
	interval := d.interval
	for {
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			if time.Now().After(d.expires) {
				return "", failure("auth_expired")
			}
			return "", failure("cancelled")
		case <-timer.C:
		}
		var result struct {
			Error       string `json:"error"`
			AccessToken string `json:"access_token"`
			IDToken     string `json:"id_token"`
		}
		code, err := postForm(ctx, d.http, d.tokenEndpoint, url.Values{"client_id": {d.clientID}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {d.deviceCode}}, &result)
		if err != nil {
			if ctx.Err() != nil {
				return "", failure("cancelled")
			}
			return "", err
		}
		switch result.Error {
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5 * time.Second
			continue
		case "expired_token":
			return "", failure("auth_expired")
		case "":
		default:
			return "", failure("auth_failed")
		}
		if code != http.StatusOK {
			return "", failure("auth_failed")
		}
		token := result.AccessToken
		if d.useIDToken {
			token = result.IDToken
		}
		if token == "" || !tokenAudienceMatches(token, d.audience) {
			return "", failure("auth_failed")
		}
		// The management service verifies the JWT signature when registering
		// this peer. Never expose the token to renderer or persist refresh tokens.
		return token, nil
	}
}
func tokenAudienceMatches(token, audience string) bool {
	if audience == "" {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Audience json.RawMessage `json:"aud"`
	}
	if json.Unmarshal(data, &claims) != nil {
		return false
	}
	var one string
	if json.Unmarshal(claims.Audience, &one) == nil {
		return one == audience
	}
	var many []string
	if json.Unmarshal(claims.Audience, &many) != nil {
		return false
	}
	for _, v := range many {
		if v == audience {
			return true
		}
	}
	return false
}
