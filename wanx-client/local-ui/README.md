# Local UI

The Electron entrypoint `../shell/entry.mjs` starts `../shell/main.mjs`.

- product UI: `renderer/`
- product IPC adapter: `remote-preload.cjs`
- menu bar panel: `panel/`
- panel IPC adapter: `panel-preload.cjs`

The adapter projects client state and forwards account, device, network, and
application actions. P2P, credentials, and application sessions stay in the shell.

## Appearance

The UI follows `docs/centaur-ui.md`: the CentaurAI light palette from
`dashboard/src/styles/theme-vars.css`, serif headings, and the original
`dashboard/public/centaurai-mark.png`. The logo is copied unchanged into
`renderer/assets/`; the local palette and asset ship inside the Electron package
without requiring the Dashboard or a remote font/image service.

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
