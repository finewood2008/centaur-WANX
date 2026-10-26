# Super Clipboard service

This service keeps its own metadata and talks to WANX personal space over HTTP.
It never opens the Octop database or receives a local identity private key.

## Managed local data mode

Install the independently built `centuarai-local-data-gate` wheel alongside
`wanx-super-clipboard[local-trust]`. The OS launcher supplies its root-owned gate
configuration and private staging directory; business backups must not replace
the configured pins or broker socket.

```sh
wanx-clipboard --upstream http://127.0.0.1:8080 --data /var/lib/wanx-clipboard \
  --local-data-mode required \
  --local-data-gate-config /etc/centuarai/clipboard-data-gate.json
```

`required` without a configuration fails before opening the service. Supplying a
configuration enables the gate even if the explicit mode flag is omitted. Once
the protected OS marker `/etc/centuarai/local-trust/required.json` exists, an
explicit `required` mode, installed gate and matching box/gateway configuration
are mandatory, including when launching this service directly. Invalid markers
fail closed and business restores cannot lower that security floor. Every
HTTP route, including documentation, requires a valid runtime-issued gateway
proof and a live private broker lease. Bearer tokens do not authorize these
requests. Standalone `legacy` mode remains explicit compatibility behavior and
must not be selected by a managed local-trust deployment.

Metadata uses a separate clipboard domain plus the verified principal namespace.
Old account UID directories are not adopted. Importing old data requires a
separate authorized migration; no migration is inferred from account names or
numeric IDs.

Calls to Octop receive new, narrowly scoped child proofs from the runtime. The
fixed application ID is `wanx.clipboard`. Ordinary objects remain inside that
principal's clipboard application folder. A user-requested export may target a
directory in the same principal's personal space only when the runtime admits
the exact parent export request and its destination. Agent reads retain the
signed space-link and task/policy checks before and after reading. The adapter
does not forward cloud authorization, stored HTTP cookies, or refresh tokens.

The service checks its live lease before local database work, before committing
metadata and before returning upstream results. The shared gate additionally
enforces body verification and response closure. Cross-service file publication
and clipboard metadata are not a single transaction: a lost/revoked response
can leave an upstream upload receipt, which an authorized retry reconciles by
the existing immutable operation ID.

## Local verification

From the WANX repository root:

```sh
PYTHONPATH=services/super-clipboard:packages/local-data-gate:src \
  uv run --no-sync pytest services/super-clipboard/tests -q
```

Fixtures use temporary metadata, synthetic identities and local test transports.
They never load a user profile or connect to a production service.
