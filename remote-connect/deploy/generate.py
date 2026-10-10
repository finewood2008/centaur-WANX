"""Generate a dedicated Headscale configuration; does not change the running host."""
import argparse,json,re,ipaddress
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--domain',required=True);p.add_argument('--email',required=True);p.add_argument('--public-ip',required=True);p.add_argument('--output',required=True);a=p.parse_args()
if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',a.domain) or '.' not in a.domain:raise SystemExit('域名格式无效')
if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',a.email):raise SystemExit('邮箱格式无效')
ip=ipaddress.ip_address(a.public_ip)
if ip.version!=4 or not ip.is_global:raise SystemExit('需要公网 IPv4 地址')
out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
policy={'tagOwners':{'tag:wanx-home':['zhijun-home@'],'tag:zhijun-home':['zhijun-home@']},'acls':[{'action':'accept','src':['tag:zhijun-home'],'dst':['tag:wanx-home:28733']}]}
(out/'policy.json').write_text(json.dumps(policy,indent=2)+'\n')
(out/'config.yaml').write_text(f'''server_url: https://{a.domain}
listen_addr: 0.0.0.0:443
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false
noise:
  private_key_path: /var/lib/wanx-headscale/noise.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: true
    region_id: 999
    region_code: wanx
    region_name: WANX private relay
    stun_listen_addr: 0.0.0.0:3478
    private_key_path: /var/lib/wanx-headscale/derp.key
    ipv4: {a.public_ip}
    automatically_add_embedded_derp_region: true
  urls: []
  paths: []
  auto_update_enabled: false
database:
  type: sqlite
  sqlite:
    path: /var/lib/wanx-headscale/db.sqlite
policy:
  mode: file
  path: /etc/wanx-headscale/policy.json
dns:
  magic_dns: false
  base_domain: tailnet.{a.domain}
  override_local_dns: false
  nameservers:
    global: []
tls_letsencrypt_hostname: {a.domain}
tls_letsencrypt_cache_dir: /var/lib/wanx-headscale/acme
acme_email: {a.email}
tls_letsencrypt_challenge_type: HTTP-01
tls_letsencrypt_listen: :80
unix_socket: /var/lib/wanx-headscale/headscale.sock
unix_socket_permission: "0770"
log:
  level: warn
disable_check_updates: true
''')
print('已生成专用协调服务配置：'+str(out))
