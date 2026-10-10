from pathlib import Path
import json,subprocess,os
root=Path(__file__).resolve().parents[1];state=Path.home()/'Library/Caches/ZhijunRemoteTests/headscale';state.mkdir(parents=True,exist_ok=True,mode=0o700)
subprocess.run(['/opt/homebrew/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',str(state/'tls.key'),'-out',str(state/'tls.crt')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL) if not (state/'tls.crt').exists() else None
os.chmod(state/'tls.key',0o600)
policy={'tagOwners':{'tag:wanx-home':['zhijun-home@'],'tag:zhijun-home':['zhijun-home@']},'acls':[{'action':'accept','src':['tag:zhijun-home'],'dst':['tag:wanx-home:28733']}]}
(state/'policy.json').write_text(json.dumps(policy,indent=2))
(state/'config.yaml').write_text(f'''server_url: https://127.0.0.1:28740
listen_addr: 127.0.0.1:28740
metrics_listen_addr: 127.0.0.1:28741
grpc_listen_addr: 127.0.0.1:28742
grpc_allow_insecure: false
noise:
  private_key_path: {state}/noise.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: true
    region_id: 999
    region_code: local
    region_name: Local integration test
    stun_listen_addr: 127.0.0.1:34780
    private_key_path: {state}/derp.key
    ipv4: 127.0.0.1
    automatically_add_embedded_derp_region: true
  urls: []
  paths: []
  auto_update_enabled: false
tls_cert_path: {state}/tls.crt
tls_key_path: {state}/tls.key
database:
  type: sqlite
  sqlite:
    path: {state}/db.sqlite
policy:
  mode: file
  path: {state}/policy.json
dns:
  magic_dns: false
  base_domain: zhijun.test
  override_local_dns: false
  nameservers:
    global: []
unix_socket: /tmp/zhijun-headscale-test-{os.getuid()}.sock
unix_socket_permission: "0700"
log:
  level: warn
disable_check_updates: true
''')
print(str(state/'config.yaml'))
