# Team client local login storage

On 2026-10-23 the user explicitly selected local encryption to avoid repeated
macOS Keychain prompts. This is a local Team client change, not a public release.

On macOS, `shell/main.mjs` supplies `createLocalEncryption` to all existing secure
stores, including account sessions, remembered login, cached notes and pairing
metadata. Other platforms retain Electron's OS-backed storage. The local backend
uses AES-256-GCM with a random nonce and a versioned authenticated envelope. Its
random key stays under the Team profile's `local-credentials/` directory, with
directory mode 0700 and key mode 0600. This protects against other OS users; a
process able to read this user's files can also read the local key. No automatic
plaintext fallback or runtime Keychain fallback is provided.

`tools/stage-team-login-client.mjs` applies only the login-storage files to the
currently installed Team application and checks its archive before packaging.
It preserves the rest of the installed application and does not touch Mini.
The source overlay manifest includes the backend for subsequent Team builds.

Migration must run while Team is stopped and before replacing its original
executable. Compile `tools/wanx-legacy-keychain-read.c` as a Node-API addon and
run `tools/migrate-team-local-login.mjs` through that original executable with
`ELECTRON_RUN_AS_NODE=1`. The addon disables Keychain user interaction: if prior
authorization is unavailable, migration fails instead of showing a prompt.
It never logs the legacy key or decrypted content. Migration verifies all new
ciphertext before replacing files, preserves byte-for-byte encrypted originals
in a dated profile backup, and never includes another application's data.

Local verification: 52 account, storage, migration and restart tests passed.
Packaged storage and full UI startup were also checked with Keychain access
blocked; no Keychain calls occurred. Redacted results and the installation
record are in `verification/team-local-login-20261023/`.
