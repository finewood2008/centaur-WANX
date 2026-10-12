// An account can log out and log in again with the same IDs while a package is
// downloading. Identity equality alone cannot authorize that older operation.
export function createMarketSessionGuard(account) {
  let generation = 0;
  let identity = JSON.stringify(account.getIdentity());
  const unsubscribe = account.subscribe((state) => {
    const next = JSON.stringify(account.getIdentity());
    if (state.phase !== "authenticated" || next !== identity) generation += 1;
    identity = next;
  });
  return {
    captureSession() {
      const captured = generation;
      const capturedIdentity = identity;
      const assertSession = () => {
        if (
          captured !== generation ||
          capturedIdentity !== JSON.stringify(account.getIdentity()) ||
          !account.getIdentity() ||
          account.snapshot().phase !== "authenticated"
        ) {
          throw Object.assign(new Error("MARKET_SESSION_CHANGED"), { code: "MARKET_SESSION_CHANGED" });
        }
      };
      assertSession();
      return assertSession;
    },
    close() { generation += 1; unsubscribe(); },
  };
}
