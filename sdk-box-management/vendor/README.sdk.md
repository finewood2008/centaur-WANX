# @nexusaos/device-management-uni

Credential-injected consumer account and device-management client for
uni-app. This package contains no UI, token constants, private-key storage, or
platform-specific keystore implementation. The embedding application supplies
the request, storage, and secure signing ports.

It covers SMS login/refresh/logout, client registration and revocation, the
consumer device list, ownership transfers, support sessions, OTA control, and
factory reset. It does not scan Bluetooth, provision Wi-Fi, establish a P2P
transport, or replace `@nexusaos/connectivity-uni-native`.

```ts
import { createUniDeviceManagementClient } from "@nexusaos/device-management-uni";

const client = createUniDeviceManagementClient({
  baseUrl: "https://boss.example/prod-api",
  request: requestThroughUni,
  storage: uniStorage,
  keyAdapter: androidKeystoreAdapter,
  // Supply one application-wide coordinator when multiple SDK client
  // instances can share the same rotating account session.
  refreshCoordinator: coordinateAccountRefresh,
  // Mirror SDK-driven expiry/revocation into the application state store.
  onSessionCleared: clearApplicationAccountSession,
});

const devices = await client.getDevices();
```

The client signs protected calls using `NEXUSAOS-CONSUMER-V1`. Access and
refresh tokens remain in the injected storage/request implementation. Do not
send a discovery `transport_id` to these APIs; only a verified Admin
`deviceId` may be used for management operations.

Concurrent refreshes made through the same client are automatically
single-flight. If an application creates multiple clients over the same
account storage, it must inject one shared `refreshCoordinator`; this prevents
separate clients from consuming the same one-time rotating refresh token.
`onSessionCleared` removes the need for an embedding app to infer logout from
the order in which individual storage keys are deleted.
