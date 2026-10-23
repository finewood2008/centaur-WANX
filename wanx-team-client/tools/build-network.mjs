import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = {
  "darwin-arm64": ["darwin", "arm64"],
  "darwin-x64": ["darwin", "amd64"],
  "win32-x64": ["windows", "amd64"],
  "win32-arm64": ["windows", "arm64"],
  "linux-x64": ["linux", "amd64"],
  "linux-arm64": ["linux", "arm64"],
};
const requested = process.argv.slice(2);
const names = requested.includes("--all")
  ? ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"]
  : requested.length
  ? requested
  : [`${process.platform}-${process.arch}`];
if (names.some((name) => !targets[name])) {
  throw new Error(
    `Unsupported target. Choose ${Object.keys(targets).join(", ")}`,
  );
}
function run(args, env = {}, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("go", args, {
      cwd: path.join(root, "native"),
      env: { ...process.env, ...env },
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let result = "";
    child.stdout?.on("data", (chunk) => {
      result += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(result.trim())
        : reject(new Error(`go exited ${code}`)),
    );
  });
}

// Go's module cache marks notices read-only. Replacing copied notices atomically
// keeps repeated local builds working without changing the dependency cache.
async function copyNotice(source, destination) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, await readFile(source), {
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

await mkdir(path.join(root, "native/bin"), { recursive: true });
for (const name of names) {
  const [GOOS, GOARCH] = targets[name];
  const output = path.join(
    root,
    "native/bin",
    `wanx-netbird-${name}${GOOS === "windows" ? ".exe" : ""}`,
  );
  console.log(`Building embedded network: ${name}`);
  await run(
    [
      "build",
      "-p",
      "2",
      "-mod=readonly",
      "-trimpath",
      "-ldflags=-s -w",
      "-o",
      output,
      "./cmd/wanx-netbird",
    ],
    {
      GOOS,
      GOARCH,
      CGO_ENABLED: "0",
    },
  );
}
const netbirdDir = await run(
  [
    "list",
    "-mod=readonly",
    "-m",
    "-f",
    "{{.Dir}}",
    "github.com/netbirdio/netbird",
  ],
  {},
  true,
);
await copyNotice(
  path.join(netbirdDir, "LICENSE"),
  path.join(root, "native/bin", "NETBIRD-LICENSE"),
);
// Include notices from modules actually compiled into any requested platform.
const moduleDirectories = new Map();
const versions = new Set();
for (const name of names) {
  const [GOOS, GOARCH] = targets[name];
  const deps = await run(
    [
      "list",
      "-mod=readonly",
      "-deps",
      "-f",
      "{{if .Module}}{{.Module.Path}}|{{if .Module.Replace}}{{.Module.Replace.Dir}}{{else}}{{.Module.Dir}}{{end}}|{{.Module.Path}} {{.Module.Version}}{{if .Module.Replace}} => {{.Module.Replace.Path}} {{.Module.Replace.Version}}{{end}}{{end}}",
      "./cmd/wanx-netbird",
    ],
    { GOOS, GOARCH, CGO_ENABLED: "0" },
    true,
  );
  for (const line of deps.split("\n")) {
    const [module, directory, version] = line.split("|");
    if (version) versions.add(version);
    if (module && directory && directory !== path.join(root, "native"))
      moduleDirectories.set(module, directory);
  }
}
for (const [module, directory] of moduleDirectories) {
  const entries = await readdir(directory, { withFileTypes: true });
  const notices = entries.filter(
    (entry) =>
      entry.isFile() &&
      /^(licen[cs]e|copying|notice|copyright)(\.|$|-)/i.test(entry.name),
  );
  if (!notices.length) continue;
  const destination = path.join(
    root,
    "native/bin/licenses",
    module.replaceAll("/", "_"),
  );
  await mkdir(destination, { recursive: true });
  for (const notice of notices)
    await copyNotice(
      path.join(directory, notice.name),
      path.join(destination, notice.name),
    );
}

await writeFile(
  path.join(root, "native/bin/go-modules.txt"),
  [...versions].sort().join("\n") + "\n",
);
