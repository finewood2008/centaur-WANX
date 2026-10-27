"""Private launch environment for the trusted local Codex process."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tomllib


def config_fingerprint(config):
    # Rotation must invalidate a worker without retaining credentials in its stamp.
    return hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()


def runtime_config(allowed_server='wanx_task',service=None,owner=None):
    model=getattr(service,'model',None)
    managed=bool(getattr(model,'device_managed',False))
    provider=model.codex_provider() if managed else None
    if managed and (not owner or not provider):
        return None
    if managed:
        bundled=service.project_root/'node_modules'/'.bin'/('codex.cmd' if os.name=='nt' else 'codex')
        binary=str(bundled) if bundled.is_file() and os.access(bundled,os.X_OK) else None
    else:
        binary=shutil.which('codex')
    if not binary:
        return None
    state=service.store.root/'codex'/hashlib.sha256(owner.encode()).hexdigest() if managed else Path.home()/'.codex'
    if managed:
        state.mkdir(parents=True,exist_ok=True,mode=0o700)
    config_path=state/'config.toml'
    settings=tomllib.loads(config_path.read_text()) if config_path.exists() else {}
    config={
        'features':{'shell_tool':False,'unified_exec':False,'multi_agent':False,'multi_agent_v2':False,
                    'skill_search':False,'enable_mcp_apps':False,'tool_call_mcp_elicitation':False,
                    'apps':False,'plugins':False,'remote_plugin':False,'skip_host_skill_discovery':True,'hooks':False,
                    'browser_use':False,'browser_use_external':False,'computer_use':False,'image_generation':False,
                    'in_app_browser':False,'workspace_dependencies':False,'memories':False,'chronicle':False,
                    'goals':False,'sleep_tool':False,'tool_suggest':False,'auth_elicitation':False,'unbounded_connection_retries':False},
        'tools':{'view_image':False},'web_search':'disabled','notify':[],'hooks':{},'check_for_update_on_startup':False,'suppress_unstable_features_warning':True,
        'mcp_servers':{name:{'enabled':False} for name in settings.get('mcp_servers',{}) if name!=allowed_server},
    }
    environment={}
    if managed:
        config.update(model=provider['model'],model_provider='wanx_device',model_providers={'wanx_device':{
            'name':'WANX device provider','base_url':provider['base_url'],'wire_api':'responses',
            'env_key':'WANX_CODEX_PROXY_TOKEN','requires_openai_auth':False,'supports_websockets':False,
            'request_max_retries':0,'stream_max_retries':0,
        }})
        config['model_supports_reasoning_summaries']=provider.get('reasoning',False)
        if provider.get('reasoning_effort'):
            config['model_reasoning_effort']=provider['reasoning_effort']
        environment={'CODEX_HOME':str(state),'WANX_CODEX_PROXY_TOKEN':provider['api_key']}
    environment.update(WANX_CODEX_PATH=binary,WANX_CODEX_CONFIG=json.dumps(config),
                       WANX_CODEX_CONFIG_STAMP=str(config_path.stat().st_mtime_ns if config_path.exists() else 0))
    return environment
