const { contextBridge, ipcRenderer, webUtils } = require("electron");

function errorCode(error) {
  return String(error?.code || error?.message || "CLIENT_REQUEST_FAILED");
}

async function creditsRead(method, input) {
  const value = await ipcRenderer.invoke(`wanx-client:credits-${method}`, input);
  if (value?.ok === false && value.code === "CREDITS_NOT_CONFIGURED")
    throw Object.assign(new Error(value.code), { code: value.code });
  return value;
}

async function walletRequest(method, input) {
  const result = await ipcRenderer.invoke(`wanx-client:wallet-${method}`, input);
  if (result?.ok !== true) {
    const error = result?.error || { code: "CREDITS_INVALID_RESPONSE" };
    throw Object.assign(new Error(error.code), error);
  }
  return result.value;
}

function projectState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const account = source.account || { phase: "signed_out" };
  const authenticated = account.phase === "authenticated";
  const connection = source.connection || null;
  const networkAvailable = source.network?.enabled !== false &&
    source.platform?.phase === "ready" && ["ready", "recovering"].includes(source.network?.phase);
  const networkReady = networkAvailable && source.network?.phase === "ready";
  // Existing connections follow confirmed data-path health, not management churn.
  const connected = authenticated && source.phase === "ready" && Boolean(connection?.deviceId) &&
    (connection.mode === "local" || (networkAvailable && connection.mode === "netbird"));
  const devices = Array.isArray(source.devices)
    ? source.devices.map((device) => ({
        ...device,
        name: device.displayName || device.deviceId,
        lifecycle: device.accessState === "ready" ? "ready" : "unavailable",
        initialized: device.accessState === "ready",
      }))
    : [];

  return {
    ...source,
    connectionPhase: source.phase || "disconnected",
    route: authenticated ? "applications" : "auth",
    phase: !authenticated
      ? account.phase === "authenticating"
        ? "authenticating"
        : "signed_out"
      : connected
        ? "connected"
        : "idle",
    account: {
      ...account,
      displayName: account.profile?.displayName || "万象用户",
    },
    devices,
    networkReady,
    canLaunchApplications: connected,
    canOpenDashboard: connected && Boolean(connection.gatewayURL),
    availableDevices: devices.filter((device) => device.accessState === "ready"),
    selectedDeviceId: connection?.deviceId || null,
    activeDeviceId: connected ? connection.deviceId : null,
    provisioning: { phase: "idle", stage: null, error: null },
    diagnostics: {
      phase: source.platform?.phase || "idle",
      message: source.platform?.reason || null,
    },
  };
}

async function rawState() {
  return ipcRenderer.invoke("wanx-client:get-state");
}

async function dataRequest(action,input){const r=await ipcRenderer.invoke("wanx-client:data",{action,input});if(!r?.ok)throw new Error(r?.code||"TEAM_DATA_REQUEST_FAILED");return r.value}
async function mcpRequest(action,input){const r=await ipcRenderer.invoke("wanx-client:mcp",{action,input});if(!r?.ok)throw new Error(r?.code||"MCP_UNAVAILABLE");return r.value}
const actions = {
 "wanx.mcp-details":()=>mcpRequest("details"),
 "wanx.mcp-copy":input=>mcpRequest("copy",input),
 ...Object.fromEntries(["share-details","create-share-key","reveal-share-key","copy-share-key","copy-share-value","release-share-key"].map(name=>["data."+name,input=>dataRequest(name,input)])),
 "data.install-starlink":input=>dataRequest("install-starlink",input),
 ...Object.fromEntries(["load","open","send","stop","retry","watch","unwatch","preferences"].map(method=>[`dialogue.${method}`,input=>ipcRenderer.invoke(`wanx-client:ai-dialogue-${method}`,input)])),
  "data.initialize":input=>dataRequest("initialize",input),
  "data.warehouses":input=>dataRequest("warehouses",input),
  "data.warehouse":input=>dataRequest("warehouse",input),
  "data.create-warehouse":input=>dataRequest("create-warehouse",input),
  "data.select-warehouse":input=>dataRequest("select-warehouse",input),
  "data.documents":input=>dataRequest("documents",input),
  "data.document":input=>dataRequest("document",input),
  "data.jobs":input=>dataRequest("jobs",input),
  "data.graph":input=>dataRequest("graph",input),
  "data.retrieval":input=>dataRequest("retrieval",input),
  "data.search":input=>dataRequest("search",input),
  "data.retry-job":input=>dataRequest("retry-job",input),
  "data.build-index":input=>dataRequest("build-index",input),
  "data.processing":input=>dataRequest("processing",input),
  "data.reprocess-models":input=>dataRequest("reprocess-models",input),
  "data.select-files":input=>dataRequest("select-files",input),
  "data.select-space-files":input=>dataRequest("select-space-files",input),
  "data.space-list":input=>dataRequest("space-list",input),
  "data.release-files":input=>dataRequest("release-files",input),
  "data.upload":input=>dataRequest("upload",input),
  "data.open-starlink":input=>dataRequest("open-starlink",input),
  "notifications.read": input => ipcRenderer.invoke("wanx-client:notifications-read", { id: input?.id, all: input?.all === true }),
  "notifications.refresh": () => ipcRenderer.invoke("wanx-client:notifications-refresh"),
  "notifications.open": input => ipcRenderer.invoke("wanx-client:notifications-open", { id: input?.id }),

  "team.login": input=>ipcRenderer.invoke("wanx-client:team",{operation:"login",input}),
  "team.join": input=>ipcRenderer.invoke("wanx-client:team",{operation:"join",input}),
  "team.identity": input=>ipcRenderer.invoke("wanx-client:team",{operation:"identity",input}),
  "team.catalog": input=>ipcRenderer.invoke("wanx-client:team",{operation:"catalog",input}),
  "team.open": input=>ipcRenderer.invoke("wanx-client:team",{operation:"open",input}),
  "team.members": input=>ipcRenderer.invoke("wanx-client:team",{operation:"members",input}),
  "team.member.update": input=>ipcRenderer.invoke("wanx-client:team",{operation:"member.update",input}),
  "team.invites": input=>ipcRenderer.invoke("wanx-client:team",{operation:"invites",input}),
  "team.invite.create": input=>ipcRenderer.invoke("wanx-client:team",{operation:"invite.create",input}),
  "team.invite.revoke": input=>ipcRenderer.invoke("wanx-client:team",{operation:"invite.revoke",input}),
  "team.projects": input=>ipcRenderer.invoke("wanx-client:team",{operation:"projects",input}),
  "team.publication": input=>ipcRenderer.invoke("wanx-client:team",{operation:"publication",input}),
  "team.publication-audience": input=>ipcRenderer.invoke("wanx-client:team",{operation:"publication-audience",input}),
  "team.publish": input=>ipcRenderer.invoke("wanx-client:team",{operation:"publish",input}),
  "team.unpublish": input=>ipcRenderer.invoke("wanx-client:team",{operation:"unpublish",input}),
  "team.access": input=>ipcRenderer.invoke("wanx-client:team",{operation:"access",input}),
  "wallet.quote": input => walletRequest("quote", input),
  "wallet.catalog": () => walletRequest("catalog"),
  "wallet.balance": () => walletRequest("balance"),
  "wallet.wallet": () => walletRequest("wallet"),
  "wallet.usage": input => walletRequest("usage", input),
  "wallet.orders": input => walletRequest("orders", input),
  "wallet.order": input => walletRequest("order", input),
  "wallet.entries": input => walletRequest("entries", input),
  "wallet.calls": input => walletRequest("calls", input),
  "wallet.call": input => walletRequest("call", input),
  "wallet.summary": input => walletRequest("summary", input),
  "wallet.createOrder": input => walletRequest("createOrder", input),
  "wallet.closeOrder": input => walletRequest("closeOrder", input),
  "profile.save": input => ipcRenderer.invoke("wanx-client:profile-save", { displayName: input?.displayName }),
  "profile.avatar": () => ipcRenderer.invoke("wanx-client:profile-avatar"),
  "profile.avatar-remove": () => ipcRenderer.invoke("wanx-client:profile-avatar-remove"),
  "credits.tasks": () => creditsRead("tasks"),
  "credits.balance": () => creditsRead("balance"),
  "credits.transactions": input => creditsRead("transactions", { after: input?.after }),
  "credits.reservation": input => creditsRead("reservation", { id: input?.id }),
  "auth.login": (input) =>
    ipcRenderer.invoke("wanx-client:login-password", {
      phone: input?.username,
      password: input?.password,
      remember: input?.remember,
    }),
  "auth.send-code": (input) =>
    ipcRenderer.invoke("wanx-client:send-registration-code", { phone: input?.username }),
  "auth.register": (input) =>
    ipcRenderer.invoke("wanx-client:register", { phone: input?.username, password: input?.password, code: input?.code }),
  "auth.send-reset-code": (input) =>
    ipcRenderer.invoke("wanx-client:send-reset-code", { phone: input?.username }),
  "auth.reset-password": (input) =>
    ipcRenderer.invoke("wanx-client:reset-password", { phone: input?.username, code: input?.code, password: input?.password }),
  "auth.send-change-code": () => ipcRenderer.invoke("wanx-client:send-change-code"),
  "auth.change-password": (input) =>
    ipcRenderer.invoke("wanx-client:change-password", { code: input?.code, password: input?.password }),
  "auth.logout": () => ipcRenderer.invoke("wanx-client:logout"),
  "auth.forget-login": () => ipcRenderer.invoke("wanx-client:remembered-login-forget"),
  "devices.refresh": () => ipcRenderer.invoke("wanx-client:refresh-devices"),
  "devices.discovery": (input) => ipcRenderer.invoke("wanx-client:discovery-devices", { deviceIds: input?.deviceIds }),
  "devices.claim": (input) => ipcRenderer.invoke("wanx-client:console-claim", { claimCode: input?.claimCode, clientAttemptId: input?.clientAttemptId,
    ...(input?.expectedDeviceId === undefined ? {} : { expectedDeviceId: input.expectedDeviceId }) }),
  "devices.claim-status": (input) => ipcRenderer.invoke("wanx-client:console-claim-status", { deviceId: input?.deviceId }),
  "ownership.list": () => ipcRenderer.invoke("wanx-client:ownership-list"),
  "support.current": input => ipcRenderer.invoke("wanx-client:support-current", { deviceId: input?.deviceId }),
  "support.decide": input => ipcRenderer.invoke("wanx-client:support-decide", {
    deviceId: input?.deviceId, ownershipEpoch: input?.ownershipEpoch, requestId: input?.requestId,
    requestDigest: input?.requestDigest, decision: input?.decision, confirmed: input?.confirmed,
  }),
  "support.revoke": input => ipcRenderer.invoke("wanx-client:support-revoke", {
    deviceId: input?.deviceId, ownershipEpoch: input?.ownershipEpoch, requestId: input?.requestId,
    requestDigest: input?.requestDigest, supportSessionId: input?.supportSessionId, confirmed: input?.confirmed,
  }),
  "ownership.send-code": () => ipcRenderer.invoke("wanx-client:ownership-send-code"),
  "ownership.create": (input) => ipcRenderer.invoke("wanx-client:ownership-create", input),
  "ownership.accept": (input) => ipcRenderer.invoke("wanx-client:ownership-accept", input),

  "devices.connect": (input) =>
    ipcRenderer.invoke("wanx-client:connect-box", input?.deviceId),
  "devices.disconnect": () => ipcRenderer.invoke("wanx-client:disconnect"),
  "devices.retry": () => ipcRenderer.invoke("wanx-client:retry-connection"),
  "maintenance.open": (input) => ipcRenderer.invoke("wanx-client:maintenance-open", { tool: input?.tool, deviceId: input?.deviceId }),
  "studio.overview": input=>ipcRenderer.invoke("wanx-client:studio-overview",input),
  "studio.create": input=>ipcRenderer.invoke("wanx-client:studio-create",input),
  "studio.open": input=>ipcRenderer.invoke("wanx-client:studio-open",input),
  "studio.workspace": input=>ipcRenderer.invoke("wanx-client:studio-workspace",input),
  "studio.metadata": input=>ipcRenderer.invoke("wanx-client:studio-metadata",input),
  "studio.export": input=>ipcRenderer.invoke("wanx-client:studio-export",input),
  "studio.placement": input=>ipcRenderer.invoke("wanx-client:studio-placement",input),
  "studio.engines.list": input=>ipcRenderer.invoke("wanx-client:studio-engines-list",input),
  "studio.engines.check": input=>ipcRenderer.invoke("wanx-client:studio-engines-check",input),
  "studio.engines.default": input=>ipcRenderer.invoke("wanx-client:studio-engines-default",input),
  "studio.launch.suggest": input=>ipcRenderer.invoke("wanx-client:studio-launch-suggest",input),
  "studio.launch.sources": input=>ipcRenderer.invoke("wanx-client:studio-launch-sources",input),
  "studio.launch.configure": input=>ipcRenderer.invoke("wanx-client:studio-launch-configure",input),
  "studio.launch.start": input=>ipcRenderer.invoke("wanx-client:studio-launch-start",input),
  "studio.intake.open": input=>ipcRenderer.invoke("wanx-client:studio-intake-open",input),
  "studio.intake.send": input=>ipcRenderer.invoke("wanx-client:studio-intake-send",input),
  "studio.intake.state": input=>ipcRenderer.invoke("wanx-client:studio-intake-state",input),
  "studio.intake.events": input=>ipcRenderer.invoke("wanx-client:studio-intake-events",input),
  "studio.intake.handoff": input=>ipcRenderer.invoke("wanx-client:studio-intake-handoff",input),
  "studio.context.sources": input=>ipcRenderer.invoke("wanx-client:studio-context-sources",input),
  "studio.context.select": input=>ipcRenderer.invoke("wanx-client:studio-context-select",input),
  "studio.capabilities.list": input=>ipcRenderer.invoke("wanx-client:studio-capabilities-list",input),
  "studio.capabilities.state": input=>ipcRenderer.invoke("wanx-client:studio-capabilities-state",input),
  "studio.capabilities.check": input=>ipcRenderer.invoke("wanx-client:studio-capabilities-check",input),
  "studio.capabilities.decide": input=>ipcRenderer.invoke("wanx-client:studio-capabilities-decide",input),
  "builder.models":()=>ipcRenderer.invoke("wanx-client:builder-models"),
  "builder.acp":()=>ipcRenderer.invoke("wanx-client:builder-acp"),
  "builder.connectors":()=>ipcRenderer.invoke("wanx-client:builder-connectors"),
  "builder.skills":()=>ipcRenderer.invoke("wanx-client:builder-skills"),
  "applications.list": () => ipcRenderer.invoke("wanx-client:applications-list"),
  "market.list": () => ipcRenderer.invoke("wanx-client:market-list"),
  "market.candidate": (input) => ipcRenderer.invoke("wanx-client:market-candidate", { applicationId: input?.applicationId }),
  "market.install": (input) => ipcRenderer.invoke("wanx-client:market-install", { applicationId: input?.applicationId }),
  "market.uninstall": (input) => ipcRenderer.invoke("wanx-client:market-uninstall", { applicationId: input?.applicationId }),
  "market.rollback": (input) => ipcRenderer.invoke("wanx-client:market-rollback", { applicationId: input?.applicationId }),
  "applications.launch": (input) => ipcRenderer.invoke("wanx-client:applications-launch", input),
  "applications.request-open": (input) => ipcRenderer.invoke("wanx-client:applications-request-open", input),
  "applications.confirm-open": (input) => ipcRenderer.invoke("wanx-client:applications-confirm-open", input),
  "applications.cancel-open": (input) => ipcRenderer.invoke("wanx-client:applications-cancel-open", input),
  "desktop.startup.get": () => ipcRenderer.invoke("wanx-client:desktop-startup-get"),
  "desktop.startup.set": (input) => ipcRenderer.invoke("wanx-client:desktop-startup-set", input),
  "desktop.about": () => ipcRenderer.invoke("wanx-client:desktop-about"),
  "desktop.quit": () => ipcRenderer.invoke("wanx-client:desktop-quit"),
  "applications.select-current": (input) => ipcRenderer.invoke("wanx-client:applications-select-current", input),
  "applications.stop": (input) => ipcRenderer.invoke("wanx-client:applications-stop", input),
  ...Object.fromEntries([
    ...["check", "download", "install"].map(method => ["client", method]),
    ...["check", "plan", "execute", "status", "cancel", "resume"].map(method => ["box", method]),
  ].map(([product, method]) => [`updates.${product}.${method}`, input => ipcRenderer.invoke(`wanx-client:updates-${product}-${method}`, input)])),
};

for (const method of ["snapshot", "refresh", "stat", "list", "mkdir", "move", "trash", "restore", "purge", "uploads", "download", "downloads", "transfer", "preview", "restore-version"])
  actions[`space.${method}`] = input => ipcRenderer.invoke(`wanx-client:space-${method}`, input);

for (const method of ["create", "list", "revoke", "audit", "config", "agent-config", "spaces", "requests", "approve", "reject", "space-manage", "connection-manage", "grants", "connection-audit", "sync-status", "sync-policy", "task-records", "task-delete", "grant", "grant-revoke", "file-transfer", "storage-set", "storage-choose"])
  actions[`space.links-${method}`] = input => ipcRenderer.invoke(`wanx-client:space-links-${method}`, input);

for (const method of ["snapshot","refresh","capture","paste","choose","transfer","copy","preview","download","manage","export","note-save","note-refresh","note-command","note-paste"])
  actions[`clipboard.${method}`] = input => ipcRenderer.invoke(`wanx-client:clipboard-${method}`, input);

async function action(name, input = {}) {
  const handler = actions[name];
  if (!handler)
    return { ok: false, code: "UNKNOWN_CLIENT_ACTION", state: await getLocalState() };
  try {
    const value = await handler(input);
    return { ok: true, value, state: await getLocalState() };
  } catch (error) {
    const rawCode = errorCode(error);
    const clipboardCode = rawCode.match(/(?:^|Error: )((?:CLIPBOARD|SPACE|BOX|ACCOUNT|SECURE_STORAGE)_[A-Z0-9_]+)$/)?.[1];
    const dialogueCode = rawCode.match(/(?:^|Error: )([A-Z][A-Z0-9_]{1,80})$/)?.[1];
    return { ok: false, code: (name.startsWith("dialogue.")||name.startsWith("data.")) ? dialogueCode || "DIALOGUE_REQUEST_FAILED" : name.startsWith("clipboard.") ? clipboardCode || "CLIPBOARD_OPERATION_FAILED" : rawCode, state: await getLocalState(),
      ...(name.startsWith("wallet.") ? { request_id: error.request_id || null, details: error.details || {},
        retryable: error.retryable === true, status: error.status || null } : {}) };
  }
}

async function getLocalState() {
  return projectState(await rawState());
}

contextBridge.exposeInMainWorld(
  "wanxClient",
  Object.freeze({
    getLocalState,
    getRememberedLogin: () => ipcRenderer.invoke("wanx-client:remembered-login-get"),
    recordPaymentTiming: (input) => ipcRenderer.invoke("wanx-client:credit-payment-timing", input),
    action,
    async uploadDroppedFiles(files, input = {}) {
      try {
        if (!Array.isArray(files) || !files.length) throw new Error("SPACE_INVALID_DROP");
        const paths = files.map(file => webUtils.getPathForFile(file));
        if (paths.some(file => !file)) throw new Error("SPACE_INVALID_DROP");
        const value = await ipcRenderer.invoke("wanx-client:space-upload-dropped", { parent: input.parent || "", paths, names: files.map(file => file.name), ...(input.scope ? {scope: input.scope} : {}), ...(input.space_id ? {space_id: input.space_id} : {}) });
        if (value?.uploadRejection) return { ok: false, ...value.uploadRejection };
        return { ok: true, value };
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
    },
    async clipboardFiles(files, input={}) {
      try {
        if(!Array.isArray(files)||!files.length||files.length>20)throw new Error("CLIPBOARD_LIMIT");
        if(files.some(file=>file.size>20*1024*1024))throw new Error("CLIPBOARD_LIMIT");
        const paths=files.map(file=>webUtils.getPathForFile(file));
        let payload;
        if(paths.every(Boolean))payload={paths};
        else if(files.length===1&&["image/png","image/jpeg","image/gif","image/webp"].includes(files[0].type))payload={image:Buffer.from(await files[0].arrayBuffer()).toString("base64"),name:files[0].name,mime:files[0].type};
        else throw new Error("CLIPBOARD_VIRTUAL_FILE");
        return await action("clipboard.capture",{...payload,scope:input.scope});
      }catch(error){return {ok:false,code:errorCode(error)};}
    },
    onClipboardState(listener) {
      const receive=(_event,state)=>listener(state);ipcRenderer.on("wanx-client:clipboard-state",receive);
      return ()=>ipcRenderer.removeListener("wanx-client:clipboard-state",receive);
    },
    checkHealth: async () => ({
      ok: false,
      code: "DIAGNOSTIC_UNAVAILABLE",
      state: await getLocalState(),
    }),
    onLocalState(listener) {
      const receive = (_event, state) => listener(projectState(state));
      ipcRenderer.on("wanx-client:state", receive);
      return () => ipcRenderer.removeListener("wanx-client:state", receive);
    },
    onAIDialogue(listener) {
      const receive = (_event, value) => listener(value);
      ipcRenderer.on("wanx-client:ai-dialogue", receive);
      return () => ipcRenderer.removeListener("wanx-client:ai-dialogue", receive);
    },
    onSpaceContentChanged(listener) {
      const receive = () => listener();
      ipcRenderer.on("wanx-client:space-content-changed", receive);
      return () => ipcRenderer.removeListener("wanx-client:space-content-changed", receive);
    },
    onSpaceState(listener) {
      const receive = (_event, state) => listener(state);
      ipcRenderer.on("wanx-client:space-state", receive);
      return () => ipcRenderer.removeListener("wanx-client:space-state", receive);
    },
    onNavigate(listener) {
      const receive = (_event, page) => {
        if (["applications", "ai-dialogue", "space", "boxes", "settings", "credits", "profile", "notifications", "construction", "studio-projects", "workspace", "models", "acp", "connectors", "skills", "environment"].includes(page)) listener(page);
      };
      ipcRenderer.on("wanx-client:navigate", receive);
      return () => ipcRenderer.removeListener("wanx-client:navigate", receive);
    },
  }),
);

const setupCall = async (method, input) => {
  const result = await ipcRenderer.invoke(`wanx:setup:${method}`, input);
  if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
  return result.value;
};
let setupReady = false;
ipcRenderer.on("wanx:setup:ready", () => { setupReady = true; });

contextBridge.exposeInMainWorld("wanxSetup", {
  state: () => setupReady ? setupCall("state") : Promise.reject(Object.assign(new Error("SETUP_NOT_READY"), { code: "SETUP_NOT_READY" })),
  begin: (candidate) => setupCall("begin", candidate),
  resume: (input = {}) => setupCall("resume", input),
  confirmPhysical: () => setupCall("confirmPhysical"),
  scanWifi: () => setupCall("scanWifi"),
  wifi: (input) => setupCall("wifi", input),
  confirmOwnership: () => setupCall("confirmOwnership"),
  redeemClaimCode: (input) => setupCall("redeemClaimCode", { claimCode: input?.claimCode, clientAttemptId: input?.clientAttemptId }),
  refresh: () => setupCall("refresh"),
  cancel: () => setupCall("cancel"),
  reset: () => setupCall("reset"),
  subscribe: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("wanx:setup:state", handler);
    return () => ipcRenderer.removeListener("wanx:setup:state", handler);
  },
  onReady: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("wanx:setup:ready", handler);
    return () => ipcRenderer.removeListener("wanx:setup:ready", handler);
  },
});

contextBridge.exposeInMainWorld("wanxSetupTransport", {
  scanTimeoutMs: process.platform === "win32" ? 60000 : 30000,
  subscribe: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on("wanx:setup:transport", handler);
    return () => ipcRenderer.removeListener("wanx:setup:transport", handler);
  },
  reply: (result) => ipcRenderer.send("wanx:setup:transport-result", result),
  status: (connectionId, frame) => ipcRenderer.send("wanx:setup:transport-status", { connectionId, frame }),
});

contextBridge.exposeInMainWorld("wanxDiscovery", {
  bluetoothState: () => ipcRenderer.invoke("wanx:discovery:bluetooth-state"),
  openBluetoothSettings: async (section = "bluetooth") => {
    const result = await ipcRenderer.invoke("wanx:discovery:open-bluetooth-settings", section);
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
  },
  subscribe: (onCandidates, onSettled) => {
    const candidates = (_event, payload) => onCandidates(payload);
    const settled = (_event, payload) => onSettled(payload);
    ipcRenderer.on("nexusaos:discovery:candidates", candidates);
    ipcRenderer.on("nexusaos:discovery:settled", settled);
    return () => {
      ipcRenderer.removeListener("nexusaos:discovery:candidates", candidates);
      ipcRenderer.removeListener("nexusaos:discovery:settled", settled);
    };
  },
  cancel: (sessionId) => ipcRenderer.send("nexusaos:discovery:cancel", { sessionId }),
  select: (sessionId, candidateId) => ipcRenderer.send("nexusaos:discovery:select", { sessionId, candidateId }),
  reselect: (sessionId, candidateId) => ipcRenderer.send("nexusaos:discovery:reselect", { sessionId, candidateId }),
  forget: (sessionId) => ipcRenderer.send("nexusaos:discovery:forget", { sessionId }),
});
