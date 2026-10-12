# Local UI snapshot

This directory contains the restored local WANX client UI from before the
remote `dev/uni_deploy_20261010` branch was merged.

The remote Electron entrypoint now loads this UI through a thin preload
adapter:

- active entrypoint: `../shell/main.mjs`
- active product UI: `renderer/`
- active IPC adapter: `remote-preload.cjs`
- historical local preload snapshot: `preload.cjs`
- retained remote test control page: `../fleet/`

The adapter projects client state and forwards account, device, network, and
application actions. P2P, credentials, and application sessions stay in the shell.

## Product navigation

- Login or account restoration opens the application card homepage. Local
  installation is available before selecting a box.
- Settings owns the network switch, device discovery/setup, connection, box
  switching, and logout. Network polling updates data without replacing the
  selected page or the setup wizard.
- An application opens only when the account is authenticated, the platform and
  network are ready, and an authorized NetBird box connection is ready. Both the
  renderer and main-process launch IPC enforce this prerequisite.
- Connecting a box does not automatically open a Dashboard or application.
  Returning to Applications shows the current box and enables Open.
- Switching/disconnecting a box invalidates the existing application session.
  Reopening the application replaces that process with a new box-bound session;
  it never silently retargets the old application's requests.

## Seam verification

From the repository root:

```sh
node --test wanx-client/tests/*seam.test.mjs wanx-client/tests/setup-preload.test.mjs
```

The renderer seam executes the real renderer, preload, and control IPC with fake
platform/application boundaries. The manager seam uses the real installer, Host
socket and launcher with a fake Electron child process. Neither requires a live
account or box.
