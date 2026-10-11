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

The adapter only projects remote client state and forwards account/device
actions. P2P, network, sidecar, and Dashboard lifecycle code remain owned by
the remote shell.
