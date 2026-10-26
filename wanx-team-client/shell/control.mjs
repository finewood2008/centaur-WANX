import { displayCreditAtoms, validateCreditWallet } from "../account/credit-wallet.mjs";

import {PANEL_NOTE_METHODS,panelNoteState} from './panel-note.mjs';
import { panelSpaceState } from "./panel-space.mjs";
import { isControlSender } from "./security.mjs";
import { DIALOGUE_APPLICATION_ID } from "./ai-dialogue.mjs";

// Electron IPC errors omit custom fields. Return only this locally generated
// validation notice; all other errors retain their existing sanitization.
async function uploadResult(action) {
  try { return await action(); }
  catch (error) {
    if (error.code !== "SPACE_UPLOAD_LIMIT") throw error;
    return { uploadRejection: { code: error.code, message: error.message } };
  }
}

function text(value, max, code) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(code);
  return value.trim();
}
function phone(input) {
  const value = text(input?.phone, 32, "invalid_phone");
  if (!/^1\d{10}$/.test(value)) throw new Error("invalid_phone");
  return value;
}

function requireConnectedBox(state) {
  if (state.account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
  if (state.phase === "ready" && state.connection?.mode === "local" && state.connection.deviceId) return;
  if (state.network?.enabled === false || state.platform?.phase !== "ready" || !["ready", "recovering"].includes(state.network?.phase))
    throw new Error("NETWORK_NOT_READY");
  if (state.phase !== "ready" || state.connection?.mode !== "netbird" || !state.connection.deviceId)
    throw new Error("BOX_CONNECTION_REQUIRED");
}

export function openConnectedDashboard(client, dashboards, destination, deviceId) {
  const state = client.snapshot();
  requireConnectedBox(state);
  if (!state.connection.gatewayURL) throw new Error("BOX_CONNECTION_REQUIRED");
  if (destination && state.connection.deviceId !== deviceId) throw new Error("BOX_CONNECTION_CHANGED");
  return dashboards.open(state, destination);
}

// Remote dashboards have no account bridge. Check the exact control main frame
// for every action, including reads, and never accept network credentials here.
export function registerControlActions({
  ipcMain,
  control,
  controlURL,
  panel,
  panelURL,
  client,
  applications,
  dashboards,
  selectApplicationArchive,
  market,
  personalSpace,
  superClipboard,
  spaceLinks,
  confirmSpacePurge,
  updates,
  credits,
  creditWallet,
  accountProfile,
  aiDialogue, panelDialogue,
  support,
  uiState,
  notifications,
  desktop,
  getState,
  publishState = () => {},
  getDesktopStartup,
  setDesktopStartup,
  showAbout,
  quit,
  allowDevelopmentInstall = false,
  timings = null,
}) {
  const panelActions = new Set([
    "get-state", "applications-list", "applications-request-open", "applications-confirm-open",
    "applications-cancel-open",
    "desktop-open", "desktop-hide", "desktop-resize", "desktop-about", "panel-balance", "panel-application-names",
    "panel-space-snapshot", "panel-space-refresh", "panel-space-upload", "panel-space-transfer", "panel-note",
  ]);
  const reads = new Set(["space-links-mcp-state", "space-links-mcp-folders", "space-links-mcp-archive", "space-links-mcp-prompt", "panel-note", "panel-application-names", "support-current", "panel-space-snapshot", "panel-space-refresh", "panel-balance", "credits-tasks", "credits-balance", "credits-transactions", "credits-reservation", "get-state", "discovery-devices", "console-claim-status", "remembered-login-get", "applications-list", "studio-overview", "studio-preview-open", "studio-preview-invoke", "studio-preview-close", "studio-runtime-model", "market-list", "market-candidate", "desktop-startup-get", "desktop-resize", "credit-payment-timing"]);
  const register = (name, action) => {
    ipcMain.handle(`wanx-client:${name}`, (event, argument) => {
      const management = isControlSender(event, control, controlURL);
      if (!management && !(panelActions.has(name) && isControlSender(event, panel, panelURL)))
        throw new Error("此页面无权操作万象连接。");
      if (["applications-launch", "applications-request-open", "applications-confirm-open", "studio-preview-open"].includes(name) ||
          /^(?:panel-)?ai-dialogue-(?:send|resume|polish|version)$/.test(name)) updates?.client?.assertUsable?.();
      // Keep validation synchronous; mutations also refresh both trusted windows.
      const result = action(argument);
      if (reads.has(name) || (name.startsWith("ai-dialogue-") || name.startsWith("panel-ai-dialogue-"))) return result;
      return Promise.resolve(result).finally(() => publishState());
    });
  };
  for(const method of ["load","open","send","stop","watch","unwatch","model","legacy-open","upload","release","resume","artifact","history-update","history-export","space-list","space-grant","release-context","knowledge-list","knowledge-grant","knowledge-evidence","usage","polish","version","version-select","handoff"]) {
    const name = "panel-ai-dialogue-" + method; panelActions.add(name);
    register(name, input => { if(!panelDialogue) throw Error("DIALOGUE_UNAVAILABLE");return panelDialogue.action(method,input); });
  }
  panelActions.add("panel-assistant-open");
  register("panel-assistant-open", async input => {
    const payload=await panelDialogue.action("handoff",input);
    desktop?.showManagement("ai-dialogue");
    control.webContents.send("wanx-client:ai-dialogue",{type:"handoff",...payload});
    return {ok:true};
  });
  const creditsRead = async action => {
    try { return await action(); }
    catch (error) {
      if (error?.code === "CREDITS_NOT_CONFIGURED" || error?.message === "CREDITS_NOT_CONFIGURED")
        return { ok: false, code: "CREDITS_NOT_CONFIGURED" };
      throw error;
    }
  };
  for (const method of ["load","open","send","stop","watch","unwatch","model","legacy-open","upload","release","resume","artifact","history-update","history-export","space-list","space-grant","release-context","knowledge-list","knowledge-grant","knowledge-evidence","usage","polish","version","version-select","handoff","channels-list","channels-detail","channels-save","channels-toggle","channels-delete","channels-test","channels-start","channels-poll","channels-cancel"]) register(`ai-dialogue-${method}`, input => {
    if (!aiDialogue) throw new Error("DIALOGUE_UNAVAILABLE");
    return aiDialogue.action(method, input);
  });
  for (const action of ["spaces", "space-manage", "file-transfer", "storage-set", "storage-choose", "mcp-drives","mcp-manage","mcp-rotate","mcp-state", "mcp-issue", "mcp-revoke", "mcp-grant", "mcp-revoke-grant", "mcp-folders", "mcp-archive", "mcp-prompt", "mcp-copy"]) {
    register(`space-links-${action}`, input => {
      if (!spaceLinks) throw new Error("SPACE_LINK_UNAVAILABLE");
      return spaceLinks.manage(action, input);
    });
  }
  const requirePanelSpace = (scope, offline = false) => {
    if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
    if (offline && client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (!offline) requireConnectedBox(client.snapshot());
    if (!scope || scope !== personalSpace.snapshot().scope) throw new Error("SPACE_CONTEXT_CHANGED");
  };
  register("panel-space-snapshot", () => {
    if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
    return panelSpaceState(personalSpace.snapshot());
  });
  register("panel-space-refresh", async () => {
    if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
    requireConnectedBox(client.snapshot());
    return panelSpaceState(await personalSpace.refresh());
  });
  register("panel-space-upload", async (input = {}) => {
    requirePanelSpace(input.scope);
    if (!Array.isArray(input.paths) || !input.paths.length) throw new Error("SPACE_INVALID_DROP");
    await personalSpace.refresh();
    requirePanelSpace(input.scope);
    return uploadResult(() => personalSpace.uploads("", input.paths, input.scope, input.names));
  });
  register("panel-space-transfer", (input = {}) => {
    requirePanelSpace(input.scope, true);
    if (!["pause", "resume", "pause-batch", "resume-batch", "retry-batch"].includes(input.action)) throw new Error("PANEL_ACTION_NOT_ALLOWED");
    if (!(input.action.endsWith("-batch") ? personalSpace.snapshot().imports?.some(batch => batch.id === input.id) : personalSpace.snapshot().tasks.some(task => task.id === input.id && task.direction === "upload")))
      throw new Error("SPACE_NOT_FOUND");
    return personalSpace.transfer(input.action, input.id);
  });
  for (const method of ["snapshot", "refresh", "stat", "list", "mkdir", "move", "trash", "restore", "purge", "uploads", "download", "downloads", "transfer", "preview", "restore-version"]) {
    register(`space-${method}`, async (input = {}) => {
      if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
      if (method === "snapshot" || method === "refresh") return personalSpace[method]();
      if (method === "downloads") return personalSpace.downloads(input.ids);
      if (method === "uploads") return uploadResult(() => personalSpace.uploads(input.parent || "", undefined, input.scope, undefined, input.space_id || "personal", input.folders === true));
      if (method === "download" || method === "preview") return personalSpace[method](input.id);
      if (method === "transfer") return personalSpace.transfer(input.action, input.id);
      if (method === "purge") {
        const scope = personalSpace.snapshot().scope;
        if (!(await confirmSpacePurge?.())) return { canceled: true };
        if (scope !== personalSpace.snapshot().scope) throw new Error("SPACE_CONTEXT_CHANGED");
      }
      return personalSpace.operation(method, input);
    });
  }
  register("panel-note", async (input={}) => {
    if(!superClipboard)throw new Error("CLIPBOARD_UNAVAILABLE");
    const {method,scope,...args}=input;
    if(!PANEL_NOTE_METHODS.has(method))throw new Error("PANEL_ACTION_NOT_ALLOWED");
    if(method!=="snapshot"&&(!scope||scope!==superClipboard.snapshot().scope))throw new Error("SPACE_CONTEXT_CHANGED");
    if(method==="preview"&&!superClipboard.snapshot().note?.blocks?.some(b=>b.type==="image"&&b.item===args.id)&&!superClipboard.snapshot().tasks?.some(t=>t.kind==="image"&&t.id===args.id))throw new Error("CLIPBOARD_NOT_FOUND");
    if(method==="transfer"&&!['pause','resume'].includes(args.action))throw new Error("PANEL_ACTION_NOT_ALLOWED");
    if(method==="note-command"&&!['clear','restore','local','remote','recover-local'].includes(args.action))throw new Error("PANEL_ACTION_NOT_ALLOWED");
    return panelNoteState(await superClipboard.operation(method,{...args,...(method==="choose"?{panel:true}:{})}));
  });
  for (const method of ["snapshot","refresh","capture","paste","choose","transfer","copy","preview","download","manage","export","note-save","note-refresh","note-command","note-paste"]) {
    register(`clipboard-${method}`, async (input={}) => {
      if(!superClipboard)throw new Error("CLIPBOARD_UNAVAILABLE");
      if(method!=="snapshot" && input.scope!==superClipboard.snapshot().scope)throw new Error("SPACE_CONTEXT_CHANGED");
      if(method==="manage" && input.action==="purge") {
        if(!(await confirmSpacePurge?.()))return {canceled:true};
        if(input.scope!==superClipboard.snapshot().scope)throw new Error("SPACE_CONTEXT_CHANGED");
      }
      const {scope,...args}=input;
      return superClipboard.operation(method,args);
    });
  }
  register("space-upload-dropped", (input = {}) => {
    if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
    if (!Array.isArray(input.paths) || !input.paths.length) throw new Error("SPACE_INVALID_DROP");
    return uploadResult(() => personalSpace.uploads(input.parent || "", input.paths, input.scope, input.names, input.space_id || "personal"));
  });
  register("panel-application-names", async () => {
    if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (!market) return [];
    const { items } = await market.list();
    return items.map(({ applicationId, name }) => ({ applicationId, name }));
  });
  register("panel-balance", () => creditsRead(async () => {
    if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (creditWallet) {
      const summary = (await creditWallet.balance()).data;
      const wallet = summary.billing_backend === "qeetoken" ? (await creditWallet.wallet()).data : summary;
      if (summary.billing_backend === "qeetoken") validateCreditWallet(wallet, client.snapshot().account.accountId);
      return { available_text: wallet.balance_credit_atoms == null ? null : displayCreditAtoms(wallet.balance_credit_atoms),
        sync_state: wallet.sync_state || "synced" };
    }
    if (!credits) throw new Error("CREDITS_NOT_CONFIGURED");
    const balance = await credits.balance();
    return { available: balance.available };
  }));
  for (const method of ["balance", "transactions", "reservation", "tasks"]) {
    register(`credits-${method}`, (input) => creditsRead(() => {
      if (!credits) throw new Error("CREDITS_NOT_CONFIGURED");
      return credits[method](input);
    }));
  }
  for (const method of ["catalog", "quote", "balance", "wallet", "usage", "orders", "order", "entries", "calls", "call", "summary", "createOrder", "closeOrder"]) {
    if (!["createOrder", "closeOrder"].includes(method)) reads.add(`wallet-${method}`);
    register(`wallet-${method}`, async input => {
      try {
        if (client.snapshot().account?.phase !== "authenticated") throw Object.assign(new Error(), { code: "ACCOUNT_LOGIN_REQUIRED" });
        if (!creditWallet) throw Object.assign(new Error(), { code: "CONTRACT_NOT_CONFIGURED" });
        return { ok: true, value: await creditWallet[method](input) };
      } catch (error) {
        // Electron does not preserve custom Error fields. Use a narrow result
        // record so the UI retains contract codes and support request IDs.
        return { ok: false, error: {
          code: /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code || "") ? error.code : "CREDITS_REQUEST_FAILED",
          status: Number.isInteger(error?.status) ? error.status : null,
          request_id: error?.request_id || null,
          retryable: error?.retryable === true,
          details: error?.details || {},
        } };
      }
    });
  }
  for (const method of ["read", "refresh", "open"]) register(`notifications-${method}`, async input => {
    if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (!notifications) throw new Error("NOTIFICATIONS_UNAVAILABLE");
    if (method === "refresh") return notifications.refresh();
    if (method === "read") return notifications.markRead(input?.all === true ? { all: true } : { id: text(input?.id, 64, "NOTIFICATION_INVALID_ID") });
    const target = notifications.target(text(input?.id, 64, "NOTIFICATION_INVALID_ID"));
    if (target.category === "application") return { destination: "applications" };
    if (target.applicationId) return uiState.requestOpen(target.applicationId);
    if (target.category === "task") return { destination: "applications" };
  });
  register("credit-payment-timing", input => timings?.creditPayment(input));
  for (const [action, method] of [["profile-save", "save"], ["profile-avatar", "chooseAvatar"], ["profile-avatar-remove", "removeAvatar"]]) {
    register(action, input => {
      if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
      if (!accountProfile) throw new Error("PROFILE_UNAVAILABLE");
      if (action === "profile-save" && (!input || Object.keys(input).some(key => key !== "displayName"))) throw new Error("PROFILE_INVALID_INPUT");
      return accountProfile[method](input);
    });
  }
  register("get-state", async () => {
    if (getState) return getState();
    const installed = applications ? await applications.listInstalled() : [];
    return { ...client.snapshot(), applications: installed };
  });
  register("login-password", (input) => {
    const number = phone(input);
    if (
      typeof input.password !== "string" ||
      !input.password ||
      Buffer.byteLength(input.password, "utf8") > 72
    )
      throw new Error("invalid_credentials");
    if (input.remember !== undefined && typeof input.remember !== "boolean")
      throw new Error("invalid_credentials");
    return client.loginPassword({ phone: number, password: input.password,
      ...(input.remember !== undefined ? { remember: input.remember } : {}) }, { waitForDevices: false });
  });
  register("remembered-login-get", () => client.getRememberedLogin());
  register("remembered-login-forget", () => client.forgetRememberedLogin());
  register("login-sms", (input) => {
    const number = phone(input);
    const code = text(input?.code, 12, "invalid_sms_code");
    if (!/^\d{6}$/.test(code)) throw new Error("invalid_sms_code");
    return client.loginSMS({ phone: number, code }, { waitForDevices: false });
  });
  register("send-sms", (input) => client.sendSMS({ phone: phone(input) }));
  register("send-registration-code", (input) => client.sendSMS({ phone: phone(input), scene: "consumer_register" }));
  register("register", (input) => {
    const number = phone(input);
    if (typeof input.password !== "string" || Buffer.byteLength(input.password, "utf8") < 8 ||
      Buffer.byteLength(input.password, "utf8") > 72 || /[\r\n\0]/.test(input.password))
      throw new Error("invalid_credentials");
    const code = text(input.code, 12, "invalid_sms_code");
    if (!/^\d{6}$/.test(code)) throw new Error("invalid_sms_code");
    return client.register({ phone: number, password: input.password, code }, { waitForDevices: false });
  });
  register("send-reset-code", (input) => client.sendResetCode({ phone: phone(input) }));
  register("send-change-code", () => client.sendChangeCode());
  for (const [action, method] of [["reset-password", "resetPassword"], ["change-password", "changePassword"]]) {
    register(action, (input) => {
      const number = action === "reset-password" ? phone(input) : undefined;
      if (typeof input?.password !== "string" || Buffer.byteLength(input.password, "utf8") < 8 ||
          Buffer.byteLength(input.password, "utf8") > 72 || /[\r\n\0]/.test(input.password))
        throw new Error("invalid_credentials");
      const code = text(input?.code, 6, "invalid_sms_code");
      if (!/^\d{6}$/.test(code)) throw new Error("invalid_sms_code");
      return client[method]({ ...(number ? { phone: number } : {}), code, password: input.password });
    });
  }
  register("logout", () => { uiState?.invalidateOpen(); return client.logout(); });
  register("refresh-devices", () => client.refreshDevices());
  register("discovery-devices", (input) => {
    const ids = input?.deviceIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 ||
        ids.some(id => typeof id !== "string" || !/^centauros-(?:[0-9a-f]{24}|[0-9a-f]{32})$/.test(id)) ||
        new Set(ids).size !== ids.length) throw new Error("ACCOUNT_INVALID_INPUT");
    return client.lookupDeviceDiscovery([...ids]);
  });
  register("console-claim", (input) => {
    if (!input || Object.keys(input).some(key => !["claimCode", "clientAttemptId", "expectedDeviceId"].includes(key)))
      throw new Error("ACCOUNT_INVALID_INPUT");
    return client.redeemConsoleClaim({ claimCode: input.claimCode, clientAttemptId: input.clientAttemptId,
      ...(input.expectedDeviceId === undefined ? {} : { expectedDeviceId: input.expectedDeviceId }) });
  });
  register("console-claim-status", (input) => {
    if (!input || Object.keys(input).some(key => key !== "deviceId")) throw new Error("ACCOUNT_INVALID_INPUT");
    return client.getConsoleClaimAuthorization(text(input.deviceId, 36, "invalid_device"));
  });
  register("ownership-list", () => client.listOwnershipTransfers());
  for (const method of ["current", "decide", "revoke"]) register(`support-${method}`, input => {
    if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (!support) throw new Error("SUPPORT_UNAVAILABLE");
    return support[method](input);
  });
  register("ownership-send-code", () => client.sendTransferCode());
  register("ownership-create", (input) => {
    if (input?.retainData !== true) throw new Error("ACCOUNT_INVALID_INPUT");
    const verificationCode = text(input?.verificationCode, 6, "invalid_sms_code");
    if (!/^\d{6}$/.test(verificationCode)) throw new Error("invalid_sms_code");
    uiState?.invalidateOpen();
    return client.createOwnershipTransfer({ deviceId: text(input?.deviceId, 128, "invalid_device"),
      targetPhone: phone({ phone: input?.targetPhone }), verificationCode, retainData: true });
  });
  register("ownership-accept", (input) => {
    if (input?.retainData !== true) throw new Error("ACCOUNT_INVALID_INPUT");
    uiState?.invalidateOpen();
    return client.acceptOwnershipTransfer({ transferId: text(input?.transferId, 128, "ACCOUNT_INVALID_INPUT"), retainData: true });
  });

  register("connect-box", (deviceId) => {
    const id = text(deviceId, 128, "invalid_device");
    uiState?.invalidateOpen();
    return client.connectBox(id);
  });
  register("connect", (input) => {
    if (input?.mode !== "direct") throw new Error("invalid_network_mode");
    uiState?.invalidateOpen();
    return client.connect({
      mode: "direct",
      deviceId: text(input.deviceId, 128, "invalid_connection"),
      name: text(input.name, 128, "invalid_connection"),
      url: text(input.url, 2048, "invalid_endpoint"),
    });
  });
  register("disconnect", () => { uiState?.invalidateOpen(); return client.disconnect(); });
  register("retry-connection", () => client.retryConnection());
  register("dashboard-open", () => { throw new Error("DASHBOARD_TERMINAL_ONLY"); });
  register("maintenance-open", (input) => {
    if (!["terminal", "desktop"].includes(input?.tool)) throw new Error("INVALID_MAINTENANCE_TOOL");
    return openConnectedDashboard(client, dashboards, input.tool, text(input.deviceId, 128, "invalid_device"));
  });
  for (const operation of ["overview", "create", "open", "workspace", "metadata", "export", "placement"]) {
    register("studio-" + operation, input => {
      requireConnectedBox(client.snapshot());
      if (!applications?.studio) throw new Error("STUDIO_UNAVAILABLE");
      return applications.studio[operation](input);
    });
  }
  for(const [action,method]of Object.entries({"preview-open":"previewOpen","preview-invoke":"previewInvoke","preview-close":"previewClose","runtime-model":"runtimeModel","runtime-model-save":"runtimeModelSave","launch-suggest":"launchSuggest","launch-sources":"launchSources","launch-configure":"launchConfigure","launch-start":"launchStart","engines-list":"enginesList","engines-check":"enginesCheck","engines-default":"enginesDefault","intake-open":"intakeOpen","intake-send":"intakeSend","intake-state":"intakeState","intake-events":"intakeEvents","intake-handoff":"intakeHandoff","context-sources":"contextSources","context-select":"contextSelect","capabilities-list":"capabilitiesList","capabilities-decide":"capabilitiesDecide","capabilities-check":"capabilitiesCheck","capabilities-state":"capabilitiesState"}))register("studio-"+action,input=>{requireConnectedBox(client.snapshot());return applications.studio[method](input)});
  for(const [action,route]of Object.entries({"builder-models":"models","builder-acp":"acp","builder-connectors":"connectors","builder-skills":"skills"}))register(action,()=>openConnectedDashboard(client,dashboards,route,client.snapshot().connection?.deviceId));
  register("applications-list", () => applications?.listInstalled() || []);
  register("applications-install", (input) => {
    if (!allowDevelopmentInstall) throw new Error("MARKET_SIGNED_PACKAGE_REQUIRED");
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    if (input?.sourceDir !== undefined && input?.archivePath !== undefined) throw new Error("APPLICATION_SOURCE_REQUIRED");
    if (input?.sourceDir !== undefined)
      return applications.install({ sourceDir: text(input.sourceDir, 4096, "invalid_application_source") });
    if (input?.archivePath !== undefined)
      return applications.install({ archivePath: text(input.archivePath, 4096, "invalid_application_source") });
    if (!selectApplicationArchive) throw new Error("APPLICATION_ARCHIVE_PICKER_UNAVAILABLE");
    return selectApplicationArchive().then(archivePath => archivePath
      ? applications.install({ archivePath }) : { canceled: true });
  });
  register("applications-launch", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    const state = client.snapshot();
    requireConnectedBox(state);
    const id = text(input?.applicationId, 64, "invalid_application_id");
    if (id === DIALOGUE_APPLICATION_ID) { desktop?.showManagement("ai-dialogue"); return { builtin: true }; }
    return applications.launch(id);
  });
  register("applications-select-current", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    const id = text(input?.applicationId, 64, "invalid_application_id");
    const version = text(input?.version, 64, "INVALID_APPLICATION_VERSION");
    const operation = () => applications.selectCurrent(id, version);
    return uiState ? uiState.runApplicationOperation(id, "selecting", operation) : operation();
  });
  register("applications-stop", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    return applications.stop(text(input?.applicationId, 64, "invalid_application_id"));
  });
  register("applications-request-open", (input) => {
    const id = text(input?.applicationId, 64, "invalid_application_id");
    if (id === DIALOGUE_APPLICATION_ID) {
      if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
      desktop?.showManagement("ai-dialogue"); return { builtin: true };
    }
    if (!uiState) throw new Error("APPLICATIONS_UNAVAILABLE");
    return uiState.requestOpen(id);
  });
  register("applications-confirm-open", (input) => {
    if (!uiState) throw new Error("APPLICATIONS_UNAVAILABLE");
    return uiState.confirmOpen({ intentId: text(input?.intentId, 128, "invalid_intent"), deviceId: text(input?.deviceId, 128, "invalid_device") });
  });
  register("applications-cancel-open", (input) => {
    if (!uiState) throw new Error("APPLICATIONS_UNAVAILABLE");
    return uiState.cancelOpen({ intentId: text(input?.intentId, 128, "invalid_intent") });
  });
  register("desktop-open", (input) => {
    if (!["applications", "ai-dialogue", "space", "boxes", "settings", "credits", "profile", "notifications"].includes(input?.page)) throw new Error("invalid_page");
    desktop?.showManagement(input.page);
  });
  register("desktop-hide", () => desktop?.hidePanel());
  register("desktop-resize", (input) => {
    if (!Number.isFinite(input?.height)) throw new Error("invalid_panel_height");
    desktop?.resizePanel(Math.max(240, Math.min(560, Math.ceil(input.height))));
  });
  register("desktop-startup-get", () => getDesktopStartup?.());
  register("desktop-startup-set", (input) => {
    if (typeof input?.enabled !== "boolean") throw new Error("invalid_startup_setting");
    return setDesktopStartup?.(input.enabled);
  });
  register("desktop-about", () => showAbout?.());
  register("desktop-quit", () => quit?.());
  for (const [product, methods] of [["client", ["check", "download", "install"]], ["box", ["check", "plan", "execute", "status", "cancel", "resume"]]]) {
    for (const method of methods) register(`updates-${product}-${method}`, input => {
      if (!updates?.[product]) throw new Error("UPDATE_NOT_CONFIGURED");
      if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
      if (["install", "execute", "resume"].includes(method) && input?.confirmed !== true) throw new Error("UPDATE_CONFIRMATION_REQUIRED");
      return updates[product][method](input || {});
    });
  }
  for (const method of ["list", "candidate", "install", "uninstall", "rollback"]) {
    register(`market-${method}`, (input) => {
      if (!market) throw new Error("MARKET_UNAVAILABLE");
      if (client.snapshot().account?.phase !== "authenticated")
        throw new Error("ACCOUNT_LOGIN_REQUIRED");
      if (method === "list") return market.list();
      const id = text(input?.applicationId, 64, "invalid_application_id");
      const operation = () => market[method](id);
      if (method === "candidate") {
        const accountId = client.snapshot().account.accountId;
        const result = operation();
        if (notifications) {
          void Promise.resolve(result).then(async value => {
            const installed = (await applications.listInstalled()).some(row => row.applicationId === id);
            if (client.snapshot().account?.accountId === accountId) notifications.candidate(id, value, installed);
          }).catch(() => {}); // Notification observation never changes market results.
        }
        return result;
      }
      if (!uiState) return operation();
      return uiState.runApplicationOperation(id, { install: "installing", uninstall: "uninstalling", rollback: "rolling-back" }[method], operation);
    });
  }
}
