#!/usr/bin/env bash
# Run on a NEW dedicated Ubuntu/Debian server: sudo bash install-linux.sh DOMAIN EMAIL PUBLIC_IPV4
set -euo pipefail
if [[ $(id -u) != 0 || $# != 3 ]]; then echo '用法：sudo bash install-linux.sh 域名 证书通知邮箱 公网IPv4'; exit 1; fi
if [[ -e /etc/wanx-headscale/config.yaml ]]; then echo '已有部署，未覆盖。请按升级流程处理。'; exit 1; fi
WANX_DEPLOY_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
WANX_TMP=$(mktemp -d);trap 'rm -rf -- "$WANX_TMP"' EXIT
python3 "$WANX_DEPLOY_DIR/generate.py" --domain "$1" --email "$2" --public-ip "$3" --output "$WANX_TMP/config"
case $(uname -m) in x86_64) WANX_ARCH=amd64;; aarch64|arm64) WANX_ARCH=arm64;; *) echo '不支持此架构'; exit 1;; esac
WANX_BINARY="headscale_0.29.4_linux_${WANX_ARCH}"
curl --fail --location --proto '=https' --tlsv1.2 "https://github.com/juanfont/headscale/releases/download/v0.29.4/$WANX_BINARY" --output "$WANX_TMP/$WANX_BINARY"
curl --fail --location --proto '=https' --tlsv1.2 'https://github.com/juanfont/headscale/releases/download/v0.29.4/checksums.txt' --output "$WANX_TMP/checksums.txt"
python3 - "$WANX_TMP" "$WANX_BINARY" <<'PY'
from pathlib import Path
import hashlib,sys
p=Path(sys.argv[1]);name=sys.argv[2];expected=next(l.split()[0] for l in (p/'checksums.txt').read_text().splitlines() if l.split()[-1]==name)
if hashlib.sha256((p/name).read_bytes()).hexdigest()!=expected:raise SystemExit('下载校验失败')
PY
if ! id wanx-headscale >/dev/null 2>&1; then useradd --system --home-dir /var/lib/wanx-headscale --create-home --shell /usr/sbin/nologin wanx-headscale; fi
install -d -o wanx-headscale -g wanx-headscale -m 700 /var/lib/wanx-headscale
install -d -o root -g wanx-headscale -m 750 /etc/wanx-headscale
install -m 755 "$WANX_TMP/$WANX_BINARY" /usr/local/bin/wanx-headscale
install -o root -g wanx-headscale -m 640 "$WANX_TMP/config/config.yaml" /etc/wanx-headscale/config.yaml
install -o root -g wanx-headscale -m 640 "$WANX_TMP/config/policy.json" /etc/wanx-headscale/policy.json
/usr/local/bin/wanx-headscale -c /etc/wanx-headscale/config.yaml configtest
install -m 644 "$WANX_DEPLOY_DIR/wanx-headscale.service" /etc/systemd/system/wanx-headscale.service
systemctl daemon-reload
systemctl enable --now wanx-headscale
WANX_READY=0
for WANX_RETRY in $(seq 1 30); do
 if /usr/local/bin/wanx-headscale -c /etc/wanx-headscale/config.yaml users list -o json >/dev/null 2>&1; then WANX_READY=1; break; fi
 sleep 2
done
if [[ $WANX_READY != 1 ]]; then echo '服务尚未就绪，请检查 systemctl status wanx-headscale'; exit 1; fi
/usr/local/bin/wanx-headscale -c /etc/wanx-headscale/config.yaml users create zhijun-home -o json > "$WANX_TMP/user.json"
/usr/local/bin/wanx-headscale -c /etc/wanx-headscale/config.yaml apikeys create --expiration 90d -o json > "$WANX_TMP/key.json"
python3 - "$WANX_TMP" "$1" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);user=json.loads((p/'user.json').read_text());key=json.loads((p/'key.json').read_text())
v={'controlURL':'https://'+sys.argv[2],'userId':str(user['id']),'apiKey':key if isinstance(key,str) else key['key'],'serverTag':'tag:wanx-home','clientTag':'tag:zhijun-home','hostname':'wanx-home'}
out=Path('/root/wanx-remote-setup.json');out.write_text(json.dumps(v,indent=2)+'\n');out.chmod(0o600)
PY
echo '协调服务已启动。将 /root/wanx-remote-setup.json 安全传到运行 WANX 的 Mac，粘贴到远程访问面板。该文件含管理员密钥，勿放入客户端安装包。'
