// Edition is read in the trusted main process, never supplied by renderer IPC.
import { readFileSync } from 'node:fs';
import { createAIDialogue as createAssistant } from './assistant-service.mjs';
export { DIALOGUE_APPLICATION_ID } from './assistant-service.mjs';
export function createAIDialogue(options) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return createAssistant({ ...options, edition: pkg.wanxEdition === 'team' ? 'team' : 'personal' });
}
