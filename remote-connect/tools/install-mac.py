"""Install the optional remote manager without replacing the existing LAN gateway."""
from pathlib import Path
import shutil,plistlib,subprocess,os
root=Path(__file__).resolve().parents[1];service=Path.home()/'Library/Application Support/ZhijunServer';dest=service/'remote-connect'
if not (service/'identity.json').is_file():raise SystemExit('请先安装本机知君服务器。')
for folder in ['manager','ui']:
 shutil.copytree(root/folder,dest/folder,dirs_exist_ok=True)
(dest/'bin').mkdir(parents=True,exist_ok=True)
shutil.copy2(root/'bin/wanx-link-darwin-arm64',dest/'bin/wanx-link-darwin-arm64')
label='ai.centaur.zhijun.remote';job={'Label':label,'ProgramArguments':['/opt/homebrew/bin/node',str(dest/'manager/server.mjs')],'WorkingDirectory':str(service),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,'StandardOutPath':str(service/'logs/remote.log'),'StandardErrorPath':str(service/'logs/remote.log'),'EnvironmentVariables':{'ZHIJUN_SERVER_HOME':str(service),'TS_NO_LOGS_NO_SUPPORT':'true'}}
file=Path.home()/'Library/LaunchAgents'/f'{label}.plist';file.write_bytes(plistlib.dumps(job));file.chmod(0o644)
domain=f'gui/{os.getuid()}';subprocess.run(['launchctl','bootout',f'{domain}/{label}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);subprocess.run(['launchctl','bootstrap',domain,str(file)],check=True)
print('远程管理模块已安装；登录 Mac 后自动启动。未配置协调服务时，不会建立远程连接。')
