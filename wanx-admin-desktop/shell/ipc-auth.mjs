/** Renderer identity is checked on every request, including nested same-URL frames. */
export function isTrustedMainFrame(event, contents, allowedURL) {
  return (
    event.sender === contents &&
    Boolean(event.senderFrame) &&
    !event.senderFrame.parent &&
    event.senderFrame.url === allowedURL
  );
}
