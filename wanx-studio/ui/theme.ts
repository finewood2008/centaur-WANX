import{useEffect,useState}from'react';
export type ThemePreference='light'|'dark'|'system';
const key='wanx-studio.theme';
function saved():ThemePreference{try{const value=localStorage.getItem(key);if(value==='light'||value==='dark')return value}catch{}return 'system'}
export function useTheme(){
  const[theme,setTheme]=useState<ThemePreference>(saved);
  useEffect(()=>{
    const system=window.matchMedia('(prefers-color-scheme: dark)');
    const apply=()=>{const resolved=theme==='system'?(system.matches?'dark':'light'):theme;document.documentElement.dataset.theme=resolved;document.documentElement.style.colorScheme=resolved};
    try{localStorage.setItem(key,theme)}catch{}
    apply();system.addEventListener('change',apply);
    void window.wanxStudio?.setTheme?.(theme).catch(()=>{});
    return()=>system.removeEventListener('change',apply);
  },[theme]);
  return[theme,setTheme]as const;
}
