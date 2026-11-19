# The `ardia` command

The `ardia` command drives a running Ardia from the terminal. It is its own project now: source, tests, CI, version
and releases live in github.com/ardia-browser/plugins (`plugins/cli`), and its manual is
[plugins/cli/docs/cli.md](https://github.com/ardia-browser/plugins/blob/main/plugins/cli/docs/cli.md) there. This page
is what Ardia does for it: how it ships, how it's installed, and the contract the two keep.

## How Ardia ships it

- **The pin.** `apps/browser/official-plugins.json` names each official plugin Ardia bundles: its version, the GitHub
  release it comes from and the SHA-256 of each artifact (`macos-arm64`, the plugin folder; `linux-x64`, the command's
  tarball; `installer`, `install.sh`). A `null` SHA-256 means not published yet, and every release step that needs it
  refuses. `scripts/release/official-plugins.py pin cli <version>` writes the hashes of a published release, and
  `check` (in the tests) holds the file well formed and `apps/cli/install.sh` equal to the pinned installer. The app's
  official catalogue (`state/plugins/official.ts`) is held equal to it by a test.
- **macOS.** The Release workflow's `build` job, which holds no secrets, fetches the pinned folder, checks its SHA-256 and
  unpacks it (`official-plugins.py bundle`: files and folders only, its `plugin.json` must be the pinned name and
  version). The `sign` job signs its Mach-Os inside out with the app's Developer ID and hardened runtime, writes each
  plugin's payload digest into `Info.plist` (`ArdiaBuiltInPlugins`), then signs the app; `verify.sh` recomputes the
  digests on the signed app and checks every Mach-O's signature and runtime flag. The plugins repo never needs the
  signing identity. The release no longer publishes an `ardia-cli-*.tar.gz` of its own.
- **Linux** has no plugins yet, so the package carries the command for its installer: `official-plugins.py linux-cli
  <app version>` fetches the pinned linux-x64 tarball, checks it, and renames it `ardia-cli-<app version>-linux-x64.tar.gz`
  with that top folder, the name the Linux engine's installer (`ac_linux_cli.cc`) expects; `scripts/linux/package.py`
  puts it in `lib/ardia/cli/` with `apps/cli/install.sh` and its digest. The smoke's `cli-install` checks that the
  installed `ardia --version` prints a version (the command's own, not the app's).
- **`apps/cli/install.sh`** is the one file of the command kept here: the engine's Linux packaging test
  (`engine/patches/build/tests/test_linux_release.py`) reads it, and moving it would change the engine key. It is a copy
  of the pinned release's `install.sh`; when the engine is next rebuilt, that test can read the fetched installer and
  the copy can go.

## Installing it

On macOS it's the **Command Line** plugin (`docs/plugins.md` › Built-in plugins, › programs, › Official plugins): a
fresh profile is offered it in Settings › Plugins and onboarding, and one click installs it through the consent sheet.
Settings › Advanced › Command line has no switch on macOS: it's one line of status ("Not installed." with Open
Plugins, "On your PATH. It can control Ardia.", or why it isn't on PATH, with Try Again). Once installed it stays: Ardia keeps `~/.local/bin/ardia` linked to its copy in
`~/Library/Application Support/Ardia/Programs/cli/`, makes a new copy when the app brings a new version (checked against
the signed digest), and runs its after-update actions once per version (`ardia skills install --auto`,
`ardia skills refresh`, `ardia computer refresh`). **Installed means control is on**: installing turns `cliControl` on
(the sheet says so), and each launch turns it back on while Command Line is installed. The control pill's Stop turns
it off until the next launch. An `ardia` installed the old way (`~/Library/Application Support/Ardia/CLI/current`) is
adopted on update with no click when control was on: the plugin counts as installed, the link moves to the new copy,
and `CLI/current` points into the store, so paths saved through it keep working. When control was off, it isn't
adopted (`ADOPT_WITH_CONTROL_OFF` in `state/plugins/programs.ts` is false): the old `ardia` stays on PATH, untouched,
control stays off, and Command Line shows as available. The old command then reports Ardia unreachable with its own
old wording until the user installs Command Line, which adopts it and turns control on as the sheet says
(`usage_counts.plugin_adoptions_waiting` counts these). There's no uninstall from
Settings; removing the link brings it back at the next launch.

On Linux, Settings › Advanced › Command line installs it from the package (`install.sh --version <app version> --sha256
<digest>` with a `file://` URL), as before.

`cliControl` (`state/app/cliControl.ts`) stays the stored key, the control pill and the token server stay in the app
(`docs/automation.md`), and on Linux and in older data folders it means what it always did; Linux keeps its switch in
Settings › Advanced.

## The contract

- **Control protocol.** `hello` carries a protocol number both ways. Ardia answers with `protocol` (today 4) and
  `minClientProtocol`, and refuses a `hello` that names an older `protocol` with `unsupported_protocol` ("… update the
  command"); a `hello` with no `protocol` is taken as the current one, as every command before this change sent none.
  The command sends its `protocol` and refuses an Ardia whose `protocol` is under its `MIN_APP_PROTOCOL` ("… update
  Ardia"), before it sends anything else. A side raises its minimum only when it needs the other's newer behaviour, so a
  newer command against an older Ardia, or the reverse, either works or says which one to update. `ardia --version`
  reports the command's own version.
- **The plugin schema.** `docs/plugin.schema.json` is the manifest schema Ardia writes (`apps/browser/scripts/
  write-plugin-schema.mjs`; a test keeps it current). The command ships a copy for `ardia plugins check` offline, and the
  plugins repo's CI compares that copy with ardia main's.
- **Release smoke.** `scripts/release/cli-bootstrap-smoke.sh` checks that a fresh profile gets no `ardia` until it installs
  Command Line, and that an installed one gets `ardia` from the signed copy at the pinned version with `ardia tabs`
  answering. `scripts/release/token-smoke.sh` runs `ardia browse` over the real token connection with the app's built-in
  `ardia`.
- **Telemetry.** The command's events go to the same service under `source = 'ardia-cli'` (the dashboard's CLI health
  page reads them); the What's Sent copy in the app lists them, since the consent is the app's. A new CLI event needs
  that copy changed here.

## Plugin credentials

The token server (`docs/engine-build.md` › `chromium-devtools-control-token.patch`) takes two kinds of secret. The
token in `<user data dir>/Chromium/ArdiaControl.json` is the owner's `ardia` command (kind `cli`, a full DevTools
client). A plugin's browse gets a credential of its own (kind `plugin`: web pages in one window and profile, nothing
else), minted per plugin activity. A plugin process never reads `ArdiaControl.json`, and a credential never travels in
argv (any process can read another's argv through `sysctl KERN_PROCARGS2`), in the environment, in a file or in a log.

- **Mint.** The app calls `engine.cliPluginCredential {tabId}` (engine call `ac_cli_plugin_credential`, args
  `{"tab": <Chrome tab id>}`; the Mac's `EngineModule.swift` and Linux's `ac_linux_host.cc` turn the app's tab id into
  Chrome's). The scope is the window that tab is in (its `SessionID`) and that window's profile (path and whether it
  is off the record), fixed at mint time. The reply is `{"id", "credential", "window", "endpoint"}`:
  - `id`: `plugin-` and 16 hex digits; it names the credential for revoking and is not secret;
  - `credential`: the secret, `p.` and 43 base64url characters (45 ASCII bytes, no padding, no newline);
  - `window`: the scope's window `SessionID`;
  - `endpoint`: `ws://127.0.0.1:<port>/devtools/browser/<id>` while the token server runs, else `""` (turn control
    on, then mint again; a credential minted while it's off still works once it's on, but the reply can't say where).

  An unknown or closed tab answers the error `no such tab`.
- **Revoke.** `engine.cliPluginCredential {revoke: <id>}` (engine args `{"revoke": "<id>"}`) answers
  `{"revoked": true}`, or `false` for an unknown id. It forgets the credential and closes every connection made with
  it. The app revokes when the activity ends; credentials also go when the browser quits.
- **Handing it to the CLI child.** The app creates a pipe, writes the credential to it and closes its write end, and
  passes the read end to the child as an inherited fd (`posix_spawn_file_actions_adddup2`; with
  `POSIX_SPAWN_CLOEXEC_DEFAULT` nothing else leaks). It sets `ARDIA_PLUGIN_CREDENTIAL_FD=<n>`, the fd number only, and
  `ARDIA_PLUGIN_ENDPOINT=<endpoint>` (not secret: the socket refuses it without the credential). `n` is the app's
  choice; fd 3 is already the plugin channel (`ARDIA_PLUGIN_FD`), so plugin children use 4.
- **Framing on that fd: the raw credential bytes, then EOF.** No newline, no length prefix, no JSON. The 45 bytes fit
  in one pipe write (under `PIPE_BUF`), so the app writes before or right after the spawn without blocking. The reader
  reads until EOF, at most 256 bytes, then closes the fd. It refuses anything that isn't exactly `p.` followed by
  base64url characters (a trailing newline included), and an fd that is missing, isn't readable or is a terminal. The
  fd must not reach the child's own children: it arrives without `FD_CLOEXEC`, so the child closes it as soon as it
  has read it, before it spawns anything.
- **Connecting.** The child opens `<endpoint>?token=<credential>` (base64url needs no escaping) with no `Origin`
  header, exactly like the `ardia` command's browser connection. `/ardia/active` and `/json*` answer it nothing.
