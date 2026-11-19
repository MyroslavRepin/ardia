# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

Toolchain: Node 24 (`.nvmrc`), pnpm 11, Turborepo, Xcode 26+, CocoaPods. pnpm uses `nodeLinker: hoisted` because
CocoaPods and Metro resolve `react-native-macos` by path.

| Task | Command |
| --- | --- |
| Typecheck everything | `pnpm typecheck` (one package: `pnpm -C apps/browser typecheck`) |
| All tests | `pnpm test` (Turbo per package, then root `node --test` over `scripts/**/*.test.mjs` and friends) |
| One package's tests | `pnpm --filter @ardia/<pkg> test` (`browser`, `core`, `shell`, `sync`, `import`, `shaders`, `ardiacore`) |
| One browser test file | from `apps/browser`: `node --no-warnings --import ./src/test-loader.mjs --test src/state/tabs/tabs.test.mjs` |
| One core test file | from `packages/core`: `node --test src/<file>.test.ts` |
| Linux checks for shared UI | `pnpm -C apps/linux typecheck`, `pnpm -C apps/linux test:graph`, `pnpm -C apps/linux test:host` |
| Metal shaders compile | `pnpm shaders:check` |
| Build the Mac app (agents) | `scripts/agent/build-app --as <you>` (run in background; refuses JS-only changes; `--config Release`) |
| Launch a hidden instance | `scripts/agent/ac launch apps/browser/build-<you>/Build/Products/Debug/Ardia.app --data <scratch>/data` |
| Drive it | `scripts/agent/ac eval <data dir> '<function body>'` (dev harness `ac`: store, actions, runCommand, shell, engine) |
| Engine acceptance | `node packages/ardiacore/scripts/acceptance.mjs <Debug app> <scratch dir> --keep [check…]`, then `--attach <scratch dir>` |
| Engine rebuild (incremental) | `scripts/agent/engine-build --as <you>` (holds the chromium lock) |
| pod / pnpm install | `scripts/agent/locked pod -- <command>` |
| Regenerate command tables | `node apps/browser/scripts/command-tables.mjs` after editing `state/commands/commandCatalog.ts` |

Metro is already running on :8081 for every instance; never start or kill another. A JS-only change needs no rebuild,
only a relaunch of the instance. Every `scripts/agent/*` script takes `--help`. End-to-end checks (shortcuts, menus,
tab drag, sidebar, sync, import, perf) are listed with their commands in `docs/testing.md`.

## Architecture

One shared React UI (`apps/browser/src`, `packages/*/src`) runs on three native hosts:

- **macOS** (`apps/browser`, Expo SDK 54 + react-native-macos 0.81 on the Legacy architecture, zustand store, inline
  styles). Chromium owns the process: `main.swift` → `ArdiaHost.run` → `ChromeMain`, and the React Native host starts
  inside Chrome's run loop. Each app window is one `ArdiaCoreWindow` holding a Chrome `Browser` per profile with no
  Chrome toolbar or tab strip; each tab's `WebContents` is hosted in an RN view (`ArdiaWebView`).
- **Linux** (`apps/linux`): Chromium's own `chrome` serves the UI from `chrome://ardia/`; Vite aliases swap in Linux
  adapters (checked by `test:graph`). Native layer: `engine/ardiacore-linux`.
- **Windows** (`apps/browser/windows`, `packages/expo-windows`): React Native Windows hosting `chrome.dll`.

### The JS ↔ engine call path (macOS)

`engine.call("domain.verb", args)` in `packages/ardiacore/src/engine/call.ts`, typed by `src/engine/api.ts` →
the domain's Expo module `packages/ardiacore/ios/<Domain>Module.swift` → `ArdiaHost` / `ArdiaServices` /
`ArdiaWebView`, or an `ac_*` C export found by dlsym through `ArdiaEngineBridge` → `engine/chromium`
(`//chrome/browser/ardia`, Chrome's services) or `engine/ardiacore` (`//ardia/core`, windows and tabs). Replies cross
as JSON. Events come back through `ArdiaEvents` to one channel per domain; page events go through the view's single
`onPageEvent` channel, demuxed in `WebView.tsx`. Adding an engine call means a C function in
`engine/chromium/.../ac_<domain>.cc`, an engine rebuild, a row in the module's call table and a row in `api.ts`.

### Where things live

- `apps/browser/src/state/<domain>`: app state and logic by domain (tabs, windows, sidebar, splits, profiles,
  commands, settings, telemetry…); store API in `docs/store-api.md`.
- `apps/browser/src/components`: UI; `platform/` holds launch config, kill switches and `NATIVE_API_VERSION`
  (bump with `apiVersion` in `packages/shell/ios/AppModule.swift` when JS starts needing new native code).
- `packages/shell`: menus, shortcuts, windows and native primitives (`Surface` for shadows, `Symbol`, `VisualEffect`…).
- `packages/core`: pure TS omnibox parsing and suggestions. `packages/import`, `packages/sync`: Swift + TS.
- `packages/ardiacore/ios/page_script.js`: runs in every http(s)/file frame; changing it needs an app rebuild only.
- `patches/`: pnpm patches to `react-native-macos` and `expo-modules-core`, listed in `pnpm-workspace.yaml`.
- The engine tree is built outside the repo in `~/chromium-build`; `engine/patches/series` is the patch order.

### react-native-macos constraints

RN shadow props crash (use `Surface`); RCTView resets layer props (draw in sublayers); native views size subviews in
`setFrameSize`, not `layout()`; no Reanimated (use `Animated`); each native view has its own Expo module; a JS
exception while modules load opens LogBox, which crashes every instance, so typecheck after import changes.

## Read next

- `docs/agent-brief.md`: the full engine map, pod and engine file layout, test-instance rules and every launch
  variable (`ARDIA_DATA_DIR`, `ARDIA_BACKGROUND`, `ARDIA_TEST`, `ARDIA_TRACE`…).
- `docs/conventions.md`: folders, import direction, tokens, naming; enforced by `apps/browser/src/conventions.test.mjs`.
- `docs/testing.md`, `docs/engine-build.md`, `docs/dia-feature-parity.md`, `docs/dia-spec.md`.
