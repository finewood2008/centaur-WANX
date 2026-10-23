import http from "node:http";
import https from "node:https";

function failure(code) {
  return Object.assign(new Error(code), { code });
}

/** Check the public WANX health contract, without establishing a login session. */
export async function probeEndpoint(url, { signal, agent } = {}) {
  const target = new URL(url);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw failure("INVALID_TARGET_URL");
  }
  target.pathname = "/api/health";
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(target, {
      signal,
      agent: agent ?? false,
      headers: { accept: "application/json" },
    });
    const timer = setTimeout(
      () => request.destroy(failure("health_timeout")),
      8_000,
    );
    timer.unref();
    request.on("close", () => clearTimeout(timer));
    request.on("error", (error) =>
      reject(
        error.name === "AbortError" || error.code === "health_timeout"
          ? error
          : failure("health_unavailable"),
      ),
    );
    request.on("response", (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(failure("health_invalid"));
        response.destroy();
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024) {
          reject(failure("health_invalid"));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on("error", () => reject(failure("health_unavailable")));
      response.on("end", () => {
        let health;
        try {
          health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* handled below */
        }
        if (
          !health ||
          health.ok !== true ||
          typeof health.db !== "boolean" ||
          !(
            health.started_at === null ||
            Number.isSafeInteger(health.started_at)
          ) ||
          !Number.isSafeInteger(health.users_loaded) ||
          health.users_loaded < 0 ||
          !Number.isSafeInteger(health.agents_running) ||
          health.agents_running < 0
        ) {
          reject(failure("health_invalid"));
          return;
        }
        resolve(health);
      });
    });
  });
}
