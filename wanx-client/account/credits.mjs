// Read-only ledger access. Pin the authority explicitly; never use an arbitrary selected box.
const fail = code => Object.assign(new Error(code), { code });
const integer = value => Number.isSafeInteger(value);
export function createCreditsReader({ client, authorityDeviceId = "", accountRequest = null }) {
  const identity = () => {
    const s = client.snapshot();
    if (s.account?.phase !== "authenticated") throw fail("ACCOUNT_LOGIN_REQUIRED");
    if (accountRequest) return JSON.stringify([s.account.accountId, s.account.clientId]);
    if (!authorityDeviceId) throw fail("CREDITS_NOT_CONFIGURED");
    if (s.phase !== "ready" || s.connection?.deviceId !== authorityDeviceId) throw fail("CREDITS_NOT_CONNECTED");
    return JSON.stringify([s.account.accountId, s.account.clientId, s.connection]);
  };
  async function read(path) {
    const key = identity();
    const response = await (accountRequest ? accountRequest({ path }) : client.applicationRequest({ method: "GET", path }));
    if (identity() !== key) throw fail("ACCOUNT_SESSION_CHANGED");
    let value;
    try { value = JSON.parse(response.body.toString("utf8")); } catch { throw fail("CREDITS_UNAVAILABLE"); }
    if (response.status !== 200) {
      const code = value?.error?.code;
      throw fail(["CREDITS_DISABLED", "CREDITS_IDENTITY"].includes(code) ? code : "CREDITS_UNAVAILABLE");
    }
    return value;
  }
  return {
    async tasks() {
      const rows = await read("/api/credits/tasks");
      if (!Array.isArray(rows) || rows.length > 50) throw fail("CREDITS_INVALID_RESPONSE");
      return rows.map(row => {
        if (row.mode !== "shadow" || row.charged !== 0 || row.refunded !== 0 ||
            !["simulated_points", "created_at", "pending_calls"].every(k => integer(row[k]) && row[k] >= 0) ||
            typeof row.id !== "string" || typeof row.application_id !== "string") throw fail("CREDITS_INVALID_RESPONSE");
        return Object.fromEntries(["id", "application_id", "tier", "status", "simulated_points", "created_at", "ended_at", "pending_calls", "mode", "charged", "refunded"].map(k => [k, row[k]]));
      });
    },
    async balance() {
      const value = await read("/api/credits/balance");
      const keys = ["available", "held", "paid_available", "gift_available"];
      if (!keys.every(k => integer(value?.[k]) && value[k] >= 0) || value.available !== value.paid_available + value.gift_available) throw fail("CREDITS_INVALID_RESPONSE");
      return Object.fromEntries(keys.map(k => [k, value[k]]));
    },
    async transactions({ after = 0 } = {}) {
      if (!integer(after) || after < 0) throw fail("CREDITS_INVALID_INPUT");
      const rows = await read(`/api/credits/transactions?after=${after}&limit=50`);
      if (!Array.isArray(rows) || rows.length > 50) throw fail("CREDITS_INVALID_RESPONSE");
      let cursor = after;
      const items = rows.map(row => {
        if (!integer(row.sequence) || row.sequence <= cursor || !["available_delta", "held_delta", "expired_amount", "created_at"].every(k => integer(row[k])) || typeof row.event_id !== "string" || typeof row.kind !== "string") throw fail("CREDITS_INVALID_RESPONSE");
        cursor = row.sequence;
        return Object.fromEntries(["sequence", "event_id", "kind", "application_id", "reservation_id", "available_delta", "held_delta", "expired_amount", "reference", "created_at"].map(k => [k, row[k]]));
      });
      return { items, after: cursor, hasMore: rows.length === 50 };
    },
    async reservation({ id } = {}) {
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw fail("CREDITS_INVALID_INPUT");
      const row = await read(`/api/credits/reservations/${id}`);
      if (row?.reservation_id !== id || !["budget", "charged", "refunded", "expires_at"].every(k => integer(row[k]) && row[k] >= 0)) throw fail("CREDITS_INVALID_RESPONSE");
      return Object.fromEntries(["reservation_id", "application_id", "task_id", "description", "status", "budget", "charged", "refunded", "expires_at"].map(k => [k, row[k]]));
    },
  };
}
