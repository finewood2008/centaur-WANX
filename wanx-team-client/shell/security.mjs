export function isControlSender(event, control, controlURL) {
  return Boolean(
    control &&
      !control.isDestroyed() &&
      event.sender === control.webContents &&
      event.senderFrame === control.webContents.mainFrame &&
      event.senderFrame.url === controlURL,
  );
}

export function sameOrigin(candidate, gatewayURL) {
  try {
    const url = new URL(candidate);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.origin === new URL(gatewayURL).origin
    );
  } catch {
    return false;
  }
}

export function externalHTTPURL(candidate) {
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function isDashboardURL(candidate, gatewayURL) {
  if (sameOrigin(candidate, gatewayURL)) return true;
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "blob:" && url.origin === new URL(gatewayURL).origin
    );
  } catch {
    return false;
  }
}
