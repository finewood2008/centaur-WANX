import { build } from "esbuild";
await build({
  entryPoints: ["shell/session.mjs"],
  outfile: "dist-shell/session-test.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  nodePaths: ["node_modules"],
  logLevel: "warning",
});
