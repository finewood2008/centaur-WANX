#!/usr/bin/env node
import { runCli } from "../src/cli";

runCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("错误:", (e as Error).message);
    process.exit(1);
  });
