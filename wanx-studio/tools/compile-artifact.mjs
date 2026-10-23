import {compileArtifact} from '../core/artifact.mjs';
let input='';for await (const chunk of process.stdin){input+=chunk;if(input.length>4*1024*1024)process.exit(2)}
try{process.stdout.write(JSON.stringify(await compileArtifact(JSON.parse(input).files)))}catch{process.stderr.write('ARTIFACT_VALIDATION_FAILED\n');process.exitCode=1}
