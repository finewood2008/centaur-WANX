// wanx-link exposes one application service through a private tsnet node.
package main

import (
 "context"
 "encoding/json"
 "errors"
 "flag"
 "fmt"
 "io"
 "net"
 "net/netip"
 "net/url"
 "os"
 "os/signal"
 "path/filepath"
 "strings"
 "sync"
 "syscall"
 "time"

 "tailscale.com/tsnet"
)

type config struct { ControlURL string `json:"controlURL"`; Hostname string `json:"hostname"`; StateDir string `json:"stateDir"`; AuthKey string `json:"authKey"`; Mode string `json:"mode"`; Target string `json:"target"` }
var outputMu sync.Mutex
func emit(v any) { outputMu.Lock(); defer outputMu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }
func validate(c config, testLoopback bool) error {
 u,err:=url.Parse(c.ControlURL);if err!=nil||u.Host==""||u.User!=nil||u.RawQuery!=""||u.Fragment!=""||(u.Path!=""&&u.Path!="/"){return errors.New("INVALID_CONTROL_URL")}
 loop:=u.Hostname()=="127.0.0.1"||u.Hostname()=="localhost"||u.Hostname()=="::1"
 if u.Scheme!="https"&&!(testLoopback&&loop&&u.Scheme=="http"){return errors.New("HTTPS_REQUIRED")}
 if !filepath.IsAbs(c.StateDir)||len(c.Hostname)<1||len(c.Hostname)>63||strings.ContainsAny(c.Hostname," /\\\n\r"){return errors.New("INVALID_NODE_CONFIG")}
 if c.Mode!="server"&&c.Mode!="client"{return errors.New("INVALID_MODE")}
 if c.Mode=="client" {ip,e:=netip.ParseAddr(c.Target);if e!=nil||!(netip.MustParsePrefix("100.64.0.0/10").Contains(ip)||netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)){return errors.New("INVALID_REMOTE_TARGET")}}
 return nil
}
func bridge(ctx context.Context, a,b net.Conn){defer a.Close();defer b.Close();done:=make(chan struct{},2);go func(){_,_=io.Copy(a,b);done<-struct{}{}}();go func(){_,_=io.Copy(b,a);done<-struct{}{}}();select{case <-ctx.Done():case <-done:}}
func run() error {
 testLoopback:=flag.Bool("test-loopback-control",false,"allow HTTP control ONLY on loopback for integration tests");flag.Parse()
 var c config;decoder:=json.NewDecoder(io.LimitReader(os.Stdin,65536));decoder.DisallowUnknownFields();if err:=decoder.Decode(&c);err!=nil{return errors.New("INVALID_CONFIG")};if err:=validate(c,*testLoopback);err!=nil{return err}
 if err:=os.MkdirAll(c.StateDir,0700);err!=nil{return errors.New("STATE_UNAVAILABLE")};_ = os.Chmod(c.StateDir,0700)
 ctx,cancel:=signal.NotifyContext(context.Background(),os.Interrupt,syscall.SIGTERM);defer cancel()
 srv:=&tsnet.Server{Dir:c.StateDir,Hostname:c.Hostname,ControlURL:c.ControlURL,AuthKey:c.AuthKey,Logf:func(string,...any){},UserLogf:func(string,...any){}};defer srv.Close()
 emit(map[string]any{"state":"connecting"});upctx,upcancel:=context.WithTimeout(ctx,75*time.Second);defer upcancel();status,err:=srv.Up(upctx);if err!=nil{return errors.New("NETWORK_REGISTRATION_FAILED")}
 var listener net.Listener
 if c.Mode=="server"{listener,err=srv.Listen("tcp",":28733")}else{listener,err=net.Listen("tcp","127.0.0.1:0")};if err!=nil{return errors.New("LISTEN_FAILED")};defer listener.Close()
 ips:=[]string{};for _,ip:=range status.TailscaleIPs{ips=append(ips,ip.String())}
 info:=map[string]any{"state":"running","ips":ips,"mode":c.Mode};if c.Mode=="client"{info["endpoint"]="https://"+listener.Addr().String()};emit(info)
 go func(){<-ctx.Done();listener.Close()}()
 for {in,err:=listener.Accept();if err!=nil{if ctx.Err()!=nil{return nil};return errors.New("LISTEN_FAILED")};go func(){dialctx,done:=context.WithTimeout(ctx,12*time.Second);defer done();var out net.Conn;var err error
  if c.Mode=="server"{out,err=(&net.Dialer{}).DialContext(dialctx,"tcp","127.0.0.1:28733")}else{out,err=srv.Dial(dialctx,"tcp",net.JoinHostPort(c.Target,"28733"))};if err!=nil{in.Close();return};bridge(ctx,in,out)
 }()}
}
func main(){if err:=run();err!=nil{emit(map[string]any{"state":"error","code":fmt.Sprint(err)});os.Exit(1)}}
