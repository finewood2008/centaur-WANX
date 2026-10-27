"""Private launch environment for the trusted local Codex process."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tomllib

from .contracts import StudioError


_UNCONFIGURED_CODES = frozenset({
    'CODEX_OWNER_REQUIRED', 'CODEX_DEVICE_PROVIDER_UNAVAILABLE',
    'CODEX_BUNDLE_MISSING', 'CODEX_HOST_CLI_MISSING',
})


def config_fingerprint(config):
    # Rotation must invalidate a worker without retaining credentials in its stamp.
    return hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()


def runtime_config(allowed_server='wanx_task',service=None,owner=None):
    """Keep the optional-config contract used by existing task callers."""
    try:
        return resolve_runtime(allowed_server,service,owner)[0]
    except StudioError as error:
        if error.code in _UNCONFIGURED_CODES:
            return None
        raise


def _read_settings(state):
    config_path=state/'config.toml'
    try:
        stamp=config_path.stat().st_mtime_ns
    except FileNotFoundError:
        return {},0
    except OSError:
        raise StudioError('CODEX_STATE_UNAVAILABLE',503) from None
    try:
        settings=tomllib.loads(config_path.read_text(encoding='utf-8'))
    except (tomllib.TOMLDecodeError,UnicodeError):
        raise StudioError('CODEX_CONFIG_INVALID',409) from None
    except OSError:
        raise StudioError('CODEX_STATE_UNAVAILABLE',503) from None
    servers=settings.get('mcp_servers',{})
    if (not isinstance(servers,dict)
        or any(not isinstance(server,dict) for server in servers.values())
        or any(key in settings and not isinstance(settings[key],str)
               for key in ('model','model_provider','model_reasoning_effort','profile'))):
        raise StudioError('CODEX_CONFIG_INVALID',409)
    return settings,stamp


def resolve_runtime(allowed_server='wanx_task',service=None,owner=None):
    """Resolve private launch values and a separate, credential-free summary."""
    model=getattr(service,'model',None)
    managed=bool(getattr(model,'device_managed',False))
    if managed and not owner:
        raise StudioError('CODEX_OWNER_REQUIRED',409)
    provider=model.codex_provider() if managed else None
    if managed and not provider:
        raise StudioError('CODEX_DEVICE_PROVIDER_UNAVAILABLE',409)
    if managed:
        bundled=service.project_root/'node_modules'/'.bin'/('codex.cmd' if os.name=='nt' else 'codex')
        binary=str(bundled) if bundled.is_file() and os.access(bundled,os.X_OK) else None
    else:
        binary=shutil.which('codex')
    if not binary:
        raise StudioError('CODEX_BUNDLE_MISSING' if managed else 'CODEX_HOST_CLI_MISSING',409)
    try:
        state=service.store.root/'codex'/hashlib.sha256(owner.encode()).hexdigest() if managed else Path.home()/'.codex'
        if managed:
            state.mkdir(parents=True,exist_ok=True,mode=0o700)
    except OSError:
        raise StudioError('CODEX_STATE_UNAVAILABLE',503) from None
    settings,stamp=_read_settings(state)
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
                       WANX_CODEX_CONFIG_STAMP=str(stamp))
    summary={
        'configurationSource':'device-provider' if managed else 'host',
        'binarySource':'bundled' if managed else 'path',
        'model':provider['model'] if managed else settings.get('model'),
        'reasoningEffort':provider.get('reasoning_effort') if managed else 'medium',
    }
    return environment,summary
