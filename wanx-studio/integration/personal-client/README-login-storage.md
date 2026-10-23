# Mini local login storage

The user requested on 2026-10-23 that Mini use the same local encryption and
automatic login behavior as the Team client, without macOS Keychain prompts.

`tools/stage-personal-local-login.mjs` applies three files to the currently
installed Mini app: the shared `account/local-encryption.mjs`, the secure store
with the missing-file guard, and the main-process backend selection. Source for
the two shared account files is in `integration/team-client/overlay/account/`.
The remainder of the installed Mini app is preserved. The existing remembered
password and session-restore behavior remains in `account/index.mjs`.

Mini's random encryption key is private to its own profile at
`~/Library/Application Support/centuarai-wanx-client/local-credentials/`.
Team retains its separate profile and key. Ciphertext uses AES-256-GCM;
directories and key files use 0700 and 0600 permissions. As explicitly selected
by the user, this mode relies on local user file access rather than Keychain.

`tools/install-personal-local-login.mjs` quits Mini, invokes
`tools/migrate-personal-local-login.mjs` through the original executable,
backs up the original encrypted files, and installs the staged app. Its
one-time migration reuses the native reader from
`tools/wanx-legacy-keychain-read.c`, which disables Keychain user interaction.
Migration failure preserves originals; installation failure restores the old
app and migrated files. No credential values are logged.

Local package and migration records are under
`verification/personal-local-login-20261023/`. This change is installed locally;
it has not been publicly released.
