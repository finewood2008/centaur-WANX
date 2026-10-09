import {build} from '../dashboard/node_modules/esbuild/lib/main.js';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
await build({entryPoints:[root+'worker.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:root+'../src/octop/infra/boxes/sdk-host.mjs',legalComments:'eof'});
await build({entryPoints:[root+'host.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:root+'host.bundle.mjs',legalComments:'eof'});
