import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const name = `wanx-netbird-${process.platform}-${process.arch}${
  process.platform === "win32" ? ".exe" : ""
}`;
try {
  await access(new URL(`../native/bin/${name}`, import.meta.url));
} catch {
  // Development only: packaged clients contain a prebuilt native engine.
  console.log("Building WANX's embedded network engine for first use…");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./build-network.mjs", import.meta.url))],
    { stdio: "inherit" },
  );
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Embedded network build failed")),
    );
  });
}
