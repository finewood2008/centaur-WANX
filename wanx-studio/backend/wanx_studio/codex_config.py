"""Non-secret configuration for the trusted local Codex ACP process."""
import json
from pathlib import Path
import shutil
import tomllib


def runtime_config(allowed_server='wanx_task'):
    binary=shutil.which('codex')
    if not binary:
        return None
    config_path=Path.home()/'.codex/config.toml'
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
    return {'WANX_CODEX_PATH':binary,'WANX_CODEX_CONFIG':json.dumps(config),
            'WANX_CODEX_CONFIG_STAMP':str(config_path.stat().st_mtime_ns if config_path.exists() else 0)}
