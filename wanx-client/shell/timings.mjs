import { mkdir, stat, rename, appendFile } from "node:fs/promises";
import path from "node:path";

// Bounded local diagnostics contain only fixed phase names and durations.
// Never accept request URLs, device identities, errors, or credentials here.
export function createTimingRecorder({
  filePath,
  consoleOutput = false,
  maxBytes = 512 * 1024,
}) {
  let writes = Promise.resolve();
  function record(step, outcome, durationMs) {
    if (!/^[a-z]+(?:\.[a-z]+){1,3}$/.test(step)) return;
    const event = { time: new Date().toISOString(), step, outcome, durationMs };
    if (consoleOutput) console.info("[wanx-timing]", JSON.stringify(event));
    writes = writes
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const size = await stat(filePath)
          .then((s) => s.size)
          .catch(() => 0);
        if (size >= maxBytes) await rename(filePath, `${filePath}.previous`);
        await appendFile(filePath, `${JSON.stringify(event)}\n`, {
          mode: 0o600,
        });
      })
      .catch(() => {}); // Diagnostic I/O must never break a connection.
  }
  return {
    async run(step, operation) {
      const start = performance.now();
      let outcome = "failed";
      try {
        const value = await operation();
        outcome = "completed";
        return value;
      } finally {
        record(step, outcome, Math.round(performance.now() - start));
      }
    },
    flush: () => writes,
  };
}
