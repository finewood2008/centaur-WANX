package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEmbeddedIdentityIsPrivateAndReusableWithoutSetupKey(t *testing.T) {
	dir := t.TempDir()
	p := startParams{ManagementURL: "https://management.example", ConfigDir: dir, DeviceName: "wanx-test"}
	_, err := newEmbeddedEngine(p, "")
	if err == nil || err.Error() != "auth_required" {
		t.Fatalf("first start must request auth: %v", err)
	}
	p.SetupKey = "test-one-time-key"
	first, err := newEmbeddedEngine(p, "")
	if err != nil {
		t.Fatal(err)
	}
	firstConfig, err := first.(*embeddedEngine).client.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	p.SetupKey = ""
	second, err := newEmbeddedEngine(p, "")
	if err != nil {
		t.Fatal(err)
	}
	secondConfig, err := second.(*embeddedEngine).client.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	if firstConfig.PrivateKey == "" || firstConfig.PrivateKey != secondConfig.PrivateKey {
		t.Fatal("peer identity changed")
	}
	if !secondConfig.DisableClientRoutes || !secondConfig.DisableServerRoutes || !secondConfig.BlockInbound || !secondConfig.BlockLANAccess {
		t.Fatal("embedded peer must be outbound-only without system routes")
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{dir: 0700, filepath.Join(dir, "config.json"): 0600} {
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != want {
				t.Errorf("permission %o want %o", info.Mode().Perm(), want)
			}
		}
	}
	p.ManagementURL = "https://other.example"
	if _, err := newEmbeddedEngine(p, ""); err == nil || err.Error() != "auth_required" {
		t.Fatal("reused identity for different control plane")
	}
}
func TestConfigRejectsSymlinkAndInsecureManagement(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(dir, "outside")
	os.WriteFile(outside, []byte("untouched"), 0600)
	private := filepath.Join(dir, "private")
	os.Mkdir(private, 0700)
	if err := os.Symlink(outside, filepath.Join(private, "config.json")); err != nil {
		t.Skip("symlinks unavailable")
	}
	if err := secureConfigDir(private); err == nil {
		t.Fatal("accepted symlink")
	}
	for _, url := range []string{"http://example.com", "https://user:secret@example.com", "https://example.com/path"} {
		if validateParams(startParams{ManagementURL: url, ConfigDir: dir, DeviceName: "test"}) == nil {
			t.Fatalf("accepted %s", url)
		}
	}
}
