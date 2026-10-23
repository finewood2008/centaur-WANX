// An installed WANX update is authoritative. Builder may only refresh its own assets.
export function requireCurrentBaseline(baseline, archiveHash) {
  if (baseline.identity !== 'ai.centuarai.wanx.client' || baseline.preview)
    throw Error('MAIN_CLIENT_IDENTITY_MISMATCH');
  if (!baseline.archiveHash || baseline.archiveHash !== archiveHash)
    throw Error('INSTALLED_CLIENT_CHANGED_REBASE_REQUIRED');
}

export const builderClientFiles = Object.freeze([
  'local-ui/renderer/studio-home.js', 'local-ui/renderer/studio-intake.js',
  'local-ui/renderer/studio-input.js', 'local-ui/renderer/studio-home.css',
  'local-ui/renderer/construction.js', 'local-ui/renderer/construction.css',
  'applications/studio.mjs', 'studio/embedded-workspace.mjs', 'studio/embedded-preload.cjs',
]);
export const builderClientDirectories = Object.freeze(['studio/workbench/', 'applications/studio-runtime/']);
export function mayRefreshBuilderFile(file) {
  return !file.split('/').some(p=>p==='..'||p==='') && (builderClientFiles.includes(file) || builderClientDirectories.some(prefix => file.startsWith(prefix)));
}
