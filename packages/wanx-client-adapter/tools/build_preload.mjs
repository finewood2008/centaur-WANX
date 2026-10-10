import ts from "typescript";
import { readFile, writeFile } from "node:fs/promises";
const source = await readFile(new URL("../src/electron-preload.ts", import.meta.url), "utf8");
const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
await writeFile(new URL("../dist/electron-preload.cjs", import.meta.url), result.outputText);
