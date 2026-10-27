// Only the private device proxy token reaches inference; ambient login/env do not.
export function runtimeEnvironment(source=process.env){
  const env={PATH:source.PATH,LANG:source.LANG||'en_US.UTF-8',TMPDIR:source.TMPDIR};
  for(const key of ['CODEX_HOME','WANX_CODEX_PROXY_TOKEN'])if(source[key])env[key]=source[key];
  return env;
}

export function runtimeEffort(config){
  return config.model_provider==='wanx_device'?config.model_reasoning_effort:'medium';
}
