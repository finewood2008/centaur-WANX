// Edition is read in the trusted main process, never supplied by renderer IPC.
import { readFileSync } from 'node:fs';
import { createAIDialogue as createAssistant } from './assistant-service.mjs';
import { dataInteractionKey, dataOwnerKey } from '../device-trust/data-context.mjs';
export { DIALOGUE_APPLICATION_ID } from './assistant-service.mjs';
export function createAIDialogue(options) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // The shared assistant stays cloud-only unless the host supplies its
  // trusted local identity. Renderer input never selects this context.
  return createAssistant({ ...options, edition: pkg.wanxEdition === 'team' ? 'team' : 'personal',
    resolveDataContext: state => state.dataIdentity?.profileId || state.dataIdentity?.selected || state.connection?.authorization === 'local-trust-v1'
      ? { ownerKey: dataOwnerKey(state), interactionKey: dataInteractionKey(state) } : undefined });
}
