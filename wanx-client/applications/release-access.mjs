import { createMarketSessionGuard } from "../shell/market-session.mjs";

const fail = code => Object.assign(new Error(code), { code });
const MAX_LEASE_MS = 60_000;

/** Main-process authority. Neither the renderer nor an app supplies an account ID. */
export function createApplicationReleaseAccess({ account, now = () => Date.now() }) {
  const sessions = createMarketSessionGuard(account);
  return Object.freeze({
    async authorize(descriptor, { signal } = {}) {
      if (descriptor?.manifest?.releaseAccess !== "account") return null;
      if (descriptor.schemaVersion !== 3 || descriptor.manifest.protocolVersion !== 3 ||
          descriptor.applicationId !== descriptor.manifest.applicationId ||
          typeof descriptor.artifactId !== "string" || !/^[a-f0-9-]{36}$/.test(descriptor.artifactId))
        throw fail("MARKET_INVALID_DESCRIPTOR");
      const assertSession = sessions.captureSession();
      const accountId = account.getIdentity()?.accountId;
      if (typeof accountId !== "string" || !accountId) throw fail("MARKET_SESSION_CHANGED");
      const startedAt = now();
      const response = await account.request({
        method: "POST", path: `/app-api/market/artifacts/${descriptor.artifactId}/access`, body: {},
        signal: AbortSignal.any([assertSession.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
      });
      assertSession();
      signal?.throwIfAborted();
      const expires = typeof response?.expiresAt === "string" ? Date.parse(response.expiresAt) : NaN;
      const duration = response?.validForSeconds;
      if (!response || response.applicationId !== descriptor.applicationId || response.artifactId !== descriptor.artifactId ||
          response.accountId !== accountId || response.allowed !== true || !["gray", "stable"].includes(response.channel) ||
          !Number.isFinite(expires) || (duration !== undefined
            ? !Number.isInteger(duration) || duration < 1 || duration > 60
            : expires <= now() || expires > now() + MAX_LEASE_MS))
        throw fail("MARKET_RELEASE_ACCESS_INVALID");
      // Network time is part of the lifetime. A delayed response cannot extend
      // authority beyond sixty seconds from this request's start. Server TTL
      // avoids dependence on the client's absolute clock matching Admin's clock.
      const expiresAt = duration === undefined ? Math.min(expires, startedAt + MAX_LEASE_MS) : startedAt + duration * 1000;
      const assertLive = () => {
        assertSession();
        if (now() >= expiresAt) throw fail("MARKET_RELEASE_ACCESS_EXPIRED");
      };
      assertLive();
      return Object.freeze({ accountId, applicationId: descriptor.applicationId, artifactId: descriptor.artifactId,
        channel: response.channel, expiresAt, signal: assertSession.signal, assertSession, assertLive });
    },
    close: () => sessions.close(),
  });
}
