// Admin's account-owned wallet. The legacy shadow reader is deliberately separate.
const PREFIX = "/app-api/v1/credits";
const MAX_ATOMS = 9223372036854775807n;
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code, status = 422) => Object.assign(new Error(code), { code, status });
const invalid = () => fail("CREDITS_INVALID_RESPONSE", 502);
const ERROR_STATUS = {
  INVALID_REQUEST: 400, UNSUPPORTED_MEDIA_TYPE: 415, UNSUPPORTED_SCHEMA: 422,
  VALIDATION_ERROR: 422, IDEMPOTENCY_KEY_INVALID: 422, INVALID_CURSOR: 422, INVALID_USAGE_SCHEMA: 422,
  UNAUTHORIZED: 401, SCOPE_DENIED: 403, DEVICE_PROOF_INVALID: 403,
  ORDER_NOT_FOUND: 404, CALL_NOT_FOUND: 404, RESOURCE_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409, ORDER_IN_PROGRESS: 409, ORDER_ALREADY_PAID: 409, REVISION_CONFLICT: 409,
  CALL_STATE_CONFLICT: 409, USAGE_CONFLICT: 409, ACCOUNTING_RANGE_EXCEEDED: 409, CONFIGURATION_LOCKED: 409,
  CONFIGURATION_INVALID: 422, RATE_LIMITED: 429, CONTRACT_NOT_CONFIGURED: 503, SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500, QEETOKEN_UNAVAILABLE: 503, QEETOKEN_SYNC_PENDING: 503,
  QEETOKEN_MIGRATION_PENDING: 409, QEETOKEN_BILLING_REQUIRED: 409, QEETOKEN_FULFILLMENT_REQUIRED: 409,
};

export function decodeCreditEnvelope(payload, status) {
  if (!object(payload) || payload.schema_version !== "1" || !id(payload.request_id)) throw invalid();
  if (status < 200 || status >= 300 || Object.hasOwn(payload, "error")) {
    const error = payload.error;
    if (!object(error) || ERROR_STATUS[error.code] !== status || typeof error.retryable !== "boolean" ||
        typeof error.message !== "string" || !object(error.details) || Object.hasOwn(payload, "data")) throw invalid();
    const details = {};
    if (Array.isArray(error.details.blocking_order_ids) && error.details.blocking_order_ids.every(id)) {
      details.blocking_order_ids = [...error.details.blocking_order_ids];
    }
    if (Number.isSafeInteger(error.details.current_revision) && error.details.current_revision >= 0) {
      details.current_revision = error.details.current_revision;
    }
    throw Object.assign(fail(error.code, status), { schema_version: "1", request_id: payload.request_id,
      retryable: error.retryable, details });
  }
  if (!Object.hasOwn(payload, "data") || !object(payload.data)) throw invalid();
  return payload;
}

export function creditAtoms(value) {
  if (typeof value !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw invalid();
  const amount = BigInt(value);
  if (amount < -MAX_ATOMS || amount > MAX_ATOMS) throw invalid();
  return amount;
}

export function sumCreditAtoms(values) {
  const total = values.reduce((sum, value) => sum + creditAtoms(value), 0n);
  return creditAtoms(total.toString()).toString();
}

export function orderGrantCreditAtoms(order) {
  const display = order.credit_display;
  if (display === null) return null; // Known service: original obligation needs reconciliation.
  // A pre-upgrade service returns only the original v1 grant. Never multiply
  // an unversioned order by the current wallet ratio.
  if (display === undefined) {
    if (creditAtoms(order.grant_credit_atoms) <= 0n) throw invalid();
    return order.grant_credit_atoms;
  }
  if (!object(display) || !['usd-credit-1-v1', 'usd-credit-100-v2'].includes(display.currency_rule_id) ||
      display.credit_scale !== 6 || creditAtoms(display.grant_credit_atoms) <= 0n) throw invalid();
  return display.grant_credit_atoms;
}

export function formatCreditAtoms(value) {
  const amount = creditAtoms(value);
  const magnitude = amount < 0n ? -amount : amount;
  const sign = amount < 0n ? "-" : "";
  const direction = amount < 0n ? "debt" : amount > 0n ? "credit" : "zero";
  const exact = `${sign}${magnitude / 1000000n}.${String(magnitude % 1000000n).padStart(6, "0")}`;
  if (magnitude > 0n && magnitude < 10000n) return { text: "<0.01", direction, exact };
  const cents = (magnitude + 5000n) / 10000n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return { text: `${sign}${whole}.${String(cents % 100n).padStart(2, "0")}`, direction, exact };
}

export function displayCreditAtoms(value, context = "balance") {
  const formatted = formatCreditAtoms(value);
  if (formatted.text !== "<0.01") return formatted.text;
  return `${formatted.direction === "debt" ? "欠费" : context === "consumption" ? "消耗" : "余额"}不足 0.01 积分`;
}

export function validateCreditWallet(value, accountId) {
  if (!object(value) || value.view_version !== "2" || value.currency_rule_id !== "usd-credit-100-v2" ||
      value.credit_scale !== 6 || typeof value.account_id !== "string" || (accountId && value.account_id !== accountId) ||
      !["pending", "stale", "synced"].includes(value.sync_state) ||
      !Number.isSafeInteger(value.pending_executions) || value.pending_executions < 0 ||
      creditAtoms(value.remote_sequence) < 0n) throw invalid();
  for (const field of ["balance_credit_atoms", "spent_credit_atoms", "correction_credit_atoms", "net_spent_credit_atoms"]) {
    if (value.sync_state === "pending") { if (value[field] !== null) throw invalid(); }
    else creditAtoms(value[field]);
  }
  if (value.sync_state !== "pending" && (!Number.isFinite(Date.parse(value.synced_at)) ||
      creditAtoms(value.spent_credit_atoms) < 0n || creditAtoms(value.correction_credit_atoms) < 0n ||
      creditAtoms(value.spent_credit_atoms) - creditAtoms(value.correction_credit_atoms) !== creditAtoms(value.net_spent_credit_atoms))) throw invalid();
  return value;
}

function input(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail("CREDITS_INVALID_INPUT");
}

function resource(value) {
  if (!id(value) || value.length > 36) throw fail("CREDITS_INVALID_INPUT");
  return encodeURIComponent(value);
}

const filters = {
  "quote/v2": ["amount_fen"],
  "usage/v2": ["before_sequence", "limit"],
  orders: ["active", "payment_state", "fulfillment_state", "review_state", "from", "to", "cursor", "limit"],
  entries: ["kind", "order_id", "call_id", "device_id", "model_ref", "from", "to", "through_ledger_sequence", "cursor", "limit"],
  calls: ["device_id", "model_ref", "turn_id", "from", "to", "call_state", "execution_state", "execution_slot_state", "cursor", "limit"],
  summary: ["from", "to", "device_id", "model_ref"],
};

export function createCreditWallet({ request }) {
  const read = async (path, query = {}) => {
    input(query, filters[path] || []);
    const params = new URLSearchParams();
    for (const key of Object.keys(query).sort()) {
      const value = query[key];
      if (value === undefined) continue;
      if (!["string", "number", "boolean"].includes(typeof value) || String(value).length > 4096) throw fail("CREDITS_INVALID_INPUT");
      params.set(key, String(value));
    }
    const suffix = params.size ? `?${params}` : "";
    return request({ method: "GET", path: `${PREFIX}/${path}${suffix}` });
  };
  return Object.freeze({
    catalog: () => read("catalog/v2"),
    quote: value => read("quote/v2", value),
    balance: () => read("balance"),
    wallet: () => read("wallet/v2"),
    usage: query => read("usage/v2", query),
    orders: query => read("orders", query),
    entries: query => read("entries", query),
    calls: query => read("calls", query),
    summary: query => read("summary", query),
    order: async value => {
      input(value, ["order_id"]);
      return read(`orders/${resource(value.order_id)}`);
    },
    call: async value => {
      input(value, ["call_id"]);
      if (!id(value.call_id)) throw fail("CREDITS_INVALID_INPUT");
      return read(`calls/${encodeURIComponent(value.call_id)}`);
    },
    createOrder: async value => {
      input(value, ["purchase_intent_id", "amount_fen", "product_id", "product_version", "payment_channel", "currency_rule_id"]);
      if (value.payment_channel !== undefined && !["alipay", "wechat"].includes(value.payment_channel)) throw fail("CREDITS_INVALID_INPUT");
      const product = value.product_id !== undefined;
      if (value.currency_rule_id !== undefined && value.currency_rule_id !== "usd-credit-100-v2") throw fail("CREDITS_INVALID_INPUT");
      const validAmount = value.currency_rule_id ? Number.isSafeInteger(value.amount_fen) && value.amount_fen >= 1000 && value.amount_fen <= 100000 && value.amount_fen % 100 === 0 : [5000, 10000, 20000].includes(value.amount_fen);
      if (!id(value.purchase_intent_id) || (product
        ? !id(value.product_id) || !id(value.product_version) || value.amount_fen !== undefined || value.currency_rule_id !== undefined
        : value.product_version !== undefined || !validAmount)) throw fail("CREDITS_INVALID_INPUT");
      const target = product ? { product_id: value.product_id, product_version: value.product_version } : { amount_fen: value.amount_fen };
      return request({ method: "POST", path: `${PREFIX}/orders`, idempotencyKey: value.purchase_intent_id,
        body: { schema_version: "1", purchase_intent_id: value.purchase_intent_id, ...target,
          ...(value.currency_rule_id ? { currency_rule_id: value.currency_rule_id } : {}),
          ...(value.payment_channel === undefined ? {} : { payment_channel: value.payment_channel }) } });
    },
    closeOrder: async value => {
      input(value, ["order_id", "close_intent_id"]);
      const orderId = resource(value.order_id);
      if (!id(value.close_intent_id)) throw fail("CREDITS_INVALID_INPUT");
      return request({ method: "POST", path: `${PREFIX}/orders/${orderId}/close`, idempotencyKey: value.close_intent_id,
        body: { schema_version: "1", close_intent_id: value.close_intent_id } });
    },
  });
}
