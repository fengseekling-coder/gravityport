# GravityPort Operations Guide

This guide covers local operation of an existing GravityPort installation: operating modes, migration, backup, verification, and recovery. It does not replace the product overview in `README.md`, and it uses placeholders instead of a maintainer's personal paths or ports. Building and publishing releases is covered in [releasing.md](releasing.md).

## Operating Modes

### Development service

For a checkout and its sample data, start the default local service:

```bash
npm ci
npm start
```

The default address is `http://127.0.0.1:43517`. This process starts the Codex bridge, the ChatGPT desktop-app conversation tracker (it reads `.codex-global-state.json` in the Codex home folder and keeps its state in `<library>/.chatgpt-desktop-sync.json`; see [PRIVACY.md](../PRIVACY.md#chatgpt-desktop-app-conversations)), Grok media bridge, Cowart bridge, Cowart discovery, the hourly Trash purge, and the derivative worker. New media is collected only while the service is running.

### Managed local service

For a persistent local installation, use the operating system's process manager and configure a dedicated local port and library explicitly:

```bash
GRAVITYPORT_LIBRARY_DIR=/absolute/path/to/library \
MOSA_PORT=PORT \
GRAVITYPORT_WEB_CAPTURE_TOKEN='replace-with-a-random-secret' \
GRAVITYPORT_WEB_CAPTURE_ORIGINS='chrome-extension://replace-with-extension-id' \
npm start
```

Choose a port that is not already used by another GravityPort or legacy service. The service always binds to `127.0.0.1`; do not expose it through a proxy or port forward.

For a standalone runtime started with `npm start`, `GRAVITYPORT_WEB_CAPTURE_TOKEN` and `GRAVITYPORT_WEB_CAPTURE_ORIGINS` remain required when the web-capture extension is used. The origins value is a comma-separated list of exact `chrome-extension://<id>` or `moz-extension://<id>` origins. When the Token is unset, web capture must remain disabled; when the origin is absent, extension requests must be rejected. Never put the Token in a tracked file, command transcript, issue, or log.

The packaged/Desktop runtime supplies these values automatically: it persists one random Web Capture Token inside Electron `userData`, authorizes only GravityPort's two exact Chrome extension origins (the unpacked development ID and the Chrome Web Store ID), prefers port `43517`, and falls back through the reserved local discovery ports when another listener owns the preferred port. The extension verifies `/api/health`, pairs only from one of those approved `chrome-extension://` origins, and caches the resolved local address and Token in `chrome.storage.local`.

A standalone runtime refuses extension pairing unless `MOSA_WEB_CAPTURE_PAIR=auto` is set; otherwise enter the address and Token on the extension's options page. The extension auto-discovers only ports `43517`–`43521`. Scripted POST/PATCH/DELETE calls to `/api/*` need the `x-mosa-client-token` header; set a stable `MOSA_CLIENT_TOKEN` for them, since the token is otherwise random per start. The browser UI receives its own HttpOnly session cookie and needs no token.

Per-source location overrides (`CODEX_HOME`, `CODEX_GENERATED_IMAGES_DIR`, `CODEX_SESSIONS_DIR`, `GROK_SESSIONS_DIR`, `COWART_MOSA_CANVAS_DIR`, `MOSA_COWART_REGISTRY_PATH`) and `GRAVITYPORT_DISABLE_BRIDGES` (`codex`, `grok`, `cowart`, `cowartDiscovery`) are listed in [ARCHITECTURE.md](../ARCHITECTURE.md#8-配置与隐私边界).

### Desktop shell

Run the desktop shell from a checkout or build one of the currently approved desktop targets:

```bash
npm run desktop:start

# macOS arm64
npm run desktop:make

# Windows 10/11 x64 (desktop:make:windows also runs desktop:package:windows)
npm run desktop:make:windows
```

The desktop packaging commands for both macOS and Windows require Node.js 22.x. The repository pins `22.23.1` in `.nvmrc` and `.node-version`; use the version-manager file supported by your environment before packaging. The pre-scripts deliberately fail before Forge runs when another Node major is active, avoiding incomplete packages that can occur with the current Forge/Packager chain on Node.js 24. On Windows, use the same pinned Node 22.x for the initial `npm ci` as well: the clean `windows-2022` CI lane installs successfully with that runtime, while Node 24 can resolve npm's implicit native rebuild through Electron's node-gyp toolchain and require an otherwise-unnecessary ClangCL setup. General non-desktop runtime development can still use the broader root `engines.node` range.

For reproducible native packaging, build macOS on macOS and Windows on Windows (the Windows CI job is the canonical clean builder). Sharp installs its native runtime through OS-specific optional packages, so a clean macOS `npm ci` does not install `@img/sharp-win32-x64`. macOS-to-Windows cross-packaging is therefore a developer-only path unless that target package is provisioned explicitly; the Forge prune hook fails closed with an actionable error instead of producing a package with a missing native runtime.

The desktop shell defaults to `~/GravityPort Library` on `127.0.0.1:43517`, the same local service used by browser capture; a machine that already has a `~/MOSA Library` keeps using it, and only a machine without any library starts fresh with `~/GravityPort Library` (the rule lives in `lib/library-location.mjs`). A user can move an owned desktop library from **Settings → Storage → Change** (next to Storage location); the selected empty directory is persisted in the desktop user-data area and becomes the library root after GravityPort copies the existing library and restarts. Override the port with `MOSA_DESKTOP_PORT` only when a separate runtime is intentional, and the library with `GRAVITYPORT_LIBRARY_DIR`. An explicit `GRAVITYPORT_LIBRARY_DIR` always takes precedence over the saved desktop location and disables in-app relocation.

At startup, the desktop shell verifies the service identity and library path. Ordinarily, an already-running matching external service can be attached without taking ownership, while an empty port starts an owned runtime. Packaged macOS startup has one deliberate exception for the Web Capture KeepAlive handoff: as soon as the Desktop process wins Electron's single-instance lock it writes a `.mosa-desktop-starting.json` marker valid for 90 seconds (covering Desktop's bounded 30-second wait for the supervisor to yield plus its own runtime startup) into the selected library. The marker is bound to the Desktop PID plus process-start identity and is ignored/removed when expired, dead, or PID-recycled. The macOS Web Capture supervisor checks that marker before spawning and while its child runtime is active; an active child receives one graceful `SIGTERM` and the supervisor enters its existing takeover grace. macOS self-update reuses the same marker protocol for compatibility with an already-loaded supervisor: after spawning the detached update helper, the old Desktop binds a 90-second handoff marker to the helper PID/start identity before releasing its runtime. The helper keeps that marker across old-app exit, extraction, replacement, relaunch, and the unchanged 45-second readiness window; the relaunched app therefore prefers an owned runtime without trying to create a competing marker. On success the helper clears the marker only after readiness is reported; on rollback it clears the marker before restoring the previous app. Packaged Desktop also has a narrow verified-owner retirement fallback so an older matching primary runtime can be retired only after re-verifying the live service, library lock owner, PID/start identity, and requested build. It never escalates to `SIGKILL`. If a marker owner dies or the marker expires, the supervisor resumes normal background fallback automatically. A foreign listener or a GravityPort service using another library remains a conflict and is never terminated.

On macOS, closing the last window keeps the Desktop-owned runtime available so the app can be reopened from the Dock; an explicit application quit stops an owned runtime and releases its library lock. On Windows, closing the last window quits the app because GravityPort does not expose a tray re-entry point; an owned runtime is stopped through the same graceful shutdown path.

Windows 10/11 x64 is currently a **Preview / testing** target. A real Windows-machine smoke cycle on an earlier build verified application startup, SQLite, Sharp, the library/Inspector UI, and automatic Codex collection; the redesigned interface has not been re-verified on Windows hardware yet. The Windows shell keeps the native title bar but hides Electron's visible application menu row; the underlying menu remains installed so keyboard accelerators continue to work. Grok and Cowart Windows source discovery remain unverified until their real local source layouts are confirmed.

Package names, distribution tracks, code signing, in-app update verification, and release publishing are maintainer topics; see [releasing.md](releasing.md).

### C2PA / Content Credentials helper

The exporter described here is currently a backend module only: no UI, HTTP API, CLI, or MCP entry point calls it yet, so `check:c2pa-signer` is the only operator-runnable step.

GravityPort's backend C2PA exporter is intentionally side-effect isolated from the Library: it reads the managed original and writes a **new export file**; input and output may never be the same path. The exporter builds a `c2pa.actions.v2` assertion plus the custom `com.azhuilab.mosa.provenance` assertion from the sanitized `mosa.provenance.bundle/1`. It only auto-declares `trainedAlgorithmicMedia` when GravityPort provenance actually identifies a generated source or recorded generation event; unknown local imports fail closed instead of being mislabeled.

The helper executable resolution order is: explicit `MOSA_C2PATOOL_PATH`, then the newest verified C2PA helper pack under Electron `userData`, then `c2patool` on `PATH`. Development-test mode deliberately relies on c2patool's built-in **test** certificate/key and is never reported as production trust. The real integration test runs automatically when `c2patool -V` succeeds (or when `MOSA_C2PATOOL_TEST_PATH` points to a test binary); otherwise that one E2E test is skipped while manifest/policy/helper-contract tests still run.

Production signing requires an external subprocess signer and passes it through c2patool's `--signer-path` interface. GravityPort strips `C2PA_PRIVATE_KEY`, `C2PA_SIGN_CERT`, and `C2PATOOL_SETTINGS` from the c2patool child environment and does not put private keys or signing certificates in generated manifest JSON. A production signer should keep its private key in the OS keychain/TPM, Secure Enclave, HSM, or KMS and expose only the c2patool subprocess-signer protocol. Using an external signer does **not** by itself prove that its certificate chains to the C2PA Trust List; trust/conformance verification remains a separate release requirement.

Before any production export, GravityPort preflights the signer using the official subprocess protocol. The signer executable must support `--signer-info`, return JSON containing a supported `alg` plus a PEM `sign_cert` chain, and may additionally return an HTTPS `tsa_url` and bounded `reserve_size`. GravityPort validates that response, parses the public X.509 certificate chain, records only public diagnostics (algorithm, certificate SHA-256/subject/issuer/validity, TSA and reserve size), and refuses to invoke c2patool if preflight fails. During the real signing operation c2patool sends the to-be-signed bytes to the signer on stdin and expects raw signature bytes on stdout; the private key therefore stays inside the signer/KMS/HSM/keychain process.

The current GravityPort production contract is deliberately stricter than c2patool's general command-string interface: `signerPath` must be an absolute path to a non-empty regular executable, must not be a symlink, and currently must not contain whitespace or embedded command arguments. If a deployment needs profiles or KMS parameters, put that configuration inside the signer wrapper or its secure operator-managed configuration rather than concatenating request-controlled command-line text.

Operators can validate a signer without signing an asset:

```bash
npm run check:c2pa-signer -- --signer /absolute/path/to/mosa-c2pa-signer
```

This command prints public signer metadata only. It must never print or persist private-key material.

## Library Migration

Before a first migration, leave the source JSON directory untouched and use a dry run:

```bash
npm exec gravityport -- migrate --dry-run --library /absolute/path/to/library
```

The examples use the `gravityport` command name; the legacy `mosa` name still works and points at the same `bin/mosa.mjs` entry. Run these commands from the repository root: `npm exec` resolves the name from this checkout's `package.json`, while outside the checkout it would look the name up on the public npm registry (where `mosa` is an unrelated package). From anywhere else, use `node /absolute/path/to/checkout/bin/mosa.mjs <command>`.

The CLI reads legacy JSON from the checkout's `assets/` folder by default; pass `--from /absolute/path/to/legacy/assets` when the JSON library is elsewhere. Only legacy JSON libraries need migrating — a new library starts as SQLite. If a run stops, run it again (or pass `--resume`): records already in SQLite are hash-checked and skipped.

Only run the real migration after the dry run reports no issues:

```bash
npm exec gravityport -- migrate --library /absolute/path/to/library
npm exec gravityport -- verify --library /absolute/path/to/library
```

Migration checks JSON records, original files, hashes, and empty groups before marking the SQLite library completed. The migration creates a `legacy-json-backup` directory. Do not delete the original JSON source, the backup, or `mosa.db` during migration or recovery.

## Library Backup and Restore

For a completed SQLite library, create a point-in-time backup in a separate directory:

```bash
npm exec gravityport -- backup --library /absolute/path/to/library --to /absolute/path/to/backup
```

The destination must be empty or absent and must not be inside the live library (or contain it). GravityPort first takes a SQLite online backup, then copies the managed media tree and reference attachments. It verifies the copied library before publishing `backup-manifest.json`; that manifest is the completion marker and records every backed-up file's size and SHA-256 digest.

Verify a backup before relying on it or moving it to another disk:

```bash
npm exec gravityport -- backup-verify --from /absolute/path/to/backup
```

Restore only into an explicit empty directory:

```bash
npm exec gravityport -- restore --from /absolute/path/to/backup --to /absolute/path/to/restored-library
```

Restore verifies the manifest first, copies through a private staging directory, rebases managed absolute paths into the new library root, and then runs the normal SQLite/library integrity verifier. If verification fails, the incomplete destination is removed instead of being left as a usable library.

Backups are local snapshots, not synchronization. Stop or pause heavy capture/import activity when practical. The SQLite snapshot itself is consistent under concurrent writes, and reference-attachment writes are guarded, but a concurrently deleted media file can intentionally make the backup fail closed so that GravityPort never publishes a snapshot whose database references missing bytes.

## Retrieval Acceptance Baseline

Before changing text search or evaluating another search model, run the reproducible text-retrieval acceptance set:

```bash
node scripts/evaluate-retrieval-baseline.mjs
node scripts/evaluate-retrieval-baseline.mjs --json
node scripts/evaluate-retrieval-baseline.mjs --enforce
```

The fixture uses synthetic designer-library assets and realistic search phrasing, never a user's private library. `lexical` and supported `conversational` cases are release guards and must keep an expected asset in the top five. `semantic` and `visual` cases stay diagnostic: they measure the gap between recorded text search and paraphrase/image-content retrieval without claiming GravityPort already provides semantic search.

The current conversational planner is intentionally conservative: it only activates on recognizable Chinese search phrasing, removes scaffolding, then keeps CJK terms that are already present in the library's short-term index. Ordinary keyword queries retain their original semantics. Cross-language paraphrase or visual-content misses are evidence for evaluating local text/image embeddings, provided their latency, disk, privacy, and migration costs are measured separately.

Before introducing a text-embedding runtime, GravityPort also applies a small audited design-vocabulary layer when at least two independent vocabulary signals are present. It covers high-value designer terminology such as `negative space` → `留白`, `eco friendly` → `可持续`, and common key-visual/packaging/portrait phrasing. A single ordinary keyword hit is never rewritten, which keeps searches such as `editorial portrait` on the existing lexical path. These mappings are a controlled product vocabulary, not a claim of general semantic understanding; the semantic acceptance tier therefore remains diagnostic until the fixture is substantially broader.

Visual probes use generated pixel fixtures whose decisive composition facts are intentionally absent from Prompt, tags, category, group, style, and theme. The set includes spatial/color cases such as a blue portrait subject on the right, a red circle on the left, a centered green box, and a black subject under large white negative space. Text search is expected to miss these. Any future image-embedding or captioning candidate must be evaluated against the pixels themselves; passing by adding those answers to metadata would invalidate the benchmark.

## Codex Hard-Link Reclaim

Migration re-imports each record from the legacy library file rather than from the Codex path, so a library that was hard-linked before migrating holds a second copy of every Codex asset. Reclaim that space once the migration has been verified:

```bash
GRAVITYPORT_LIBRARY_DIR=/absolute/path/to/library node scripts/migrate-codex-hardlinks.mjs
```

Set `MOSA_PROJECT_ID` to select a project other than `default`; the pass covers archived assets too. It only swaps a library file for a hard link when the Codex original still exists, sits on the same filesystem, and hashes identically, so it never rewrites image bytes. Every other asset is reported under `skipped` with its reason. New imports are already hard-linked on ingest and need no maintenance.

## Derivative Repair

Thumbnails, medium images, and previews are persistent SQLite jobs, and the service re-queues assets with missing dimensions or derivatives at startup. Repair or rebuild by hand only when needed:

```bash
npm exec gravityport -- thumbnails repair --library /absolute/path/to/library
npm exec gravityport -- thumbnails rebuild --library /absolute/path/to/library
```

`repair` queues only assets whose derivative metadata or files are missing; `rebuild` regenerates every eligible asset. Both need a completed SQLite library, are resumable, exit non-zero on failed jobs or five minutes without progress, and never modify original image bytes.

## Local Build Artifact Cleanup

`npm run clean:local` deletes only explicitly regenerable local artifacts: `coverage/`, `.nyc_output/`, and the scratch namespaces `out/tmp/`, `out/qa/`, `out/inspect/`. The CLI is fixed to this GravityPort checkout and does not accept a custom repository root. It never touches release artifacts (`out/make/`, the packaged-app directories `out/MOSA-darwin-arm64/`, `out/MOSA-win32-x64/`, `out/GravityPort-darwin-arm64/`, `out/GravityPort-win32-x64/`, and `out/store/`), refuses paths outside the repository, and resolves each existing target before deletion so parent-directory symlinks cannot redirect cleanup outside the checkout. Preview the exact effect first with `npm run clean:local -- --dry-run`.

When a throwaway repack, ASAR inspection, or QA run needs a directory under `out/`, create it inside `out/tmp/`, `out/qa/`, or `out/inspect/` so the next `clean:local` removes it. Anything placed directly under `out/` is treated as a deliberate artifact and is never cleaned automatically.

## Health Checks

After starting a service, check the active storage and every bridge in one place:

```bash
curl -sS http://127.0.0.1:PORT/api/library-path
curl -sS http://127.0.0.1:PORT/api/bridges
curl -sS http://127.0.0.1:PORT/api/cowart-canvases
curl -sS http://127.0.0.1:PORT/api/web-capture
```

Expected conditions:

- `storage` is `sqlite` for a new library or after a completed migration; a legacy JSON library reports `json` until `migrate` completes.
- Codex, Grok, and Cowart report `enabled: true`; watcher/polling availability depends on the local source directories.
- Codex image and session sources should resolve beneath the same `CODEX_HOME` unless an explicit per-source override is configured. With no overrides, use `<CODEX_HOME>/generated_images` and `<CODEX_HOME>/sessions`; when `CODEX_HOME` is unset it defaults to the user's `.codex` directory.
- Codex bridge diagnostics expose independent `watchingImages` and `watchingSessions` flags. `pendingSessionResults` is the number of generation events still waiting for a standard file or recoverable session result, and `lastSessionBytesRead` shows how many JSONL bytes the most recent incremental scan actually consumed.
- Standard files under `generated_images` are always preferred. Session-result recovery is only a fallback when the standard file is unavailable; recovered bytes are validated and staged inside GravityPort's private assets area, then copied into the library and removed from staging.
- `grok.sessionsDir` points at the configured Grok sessions root (default `~/.grok/sessions`).
- `lastError` is empty or `null`.
- `cowartDiscovery` is enabled when the service can read local Codex session records.
- `webCapture.enabled` is true only when the active runtime has a local ingest Token and at least one approved extension origin. A standalone `npm start` runtime gets those values from explicit configuration; Packaged Desktop provisions them automatically for its fixed extension identities. Its providers list should contain `chatgpt`, `gemini`, `flow`, `google-ai-studio`, `jimeng`, and `midjourney`.

Run an integrity check whenever a migration, repair, or service incident is resolved:

```bash
npm exec gravityport -- verify --library /absolute/path/to/library
```

Treat `ok: true` and an empty `failures` list as the integrity result. The asset count is a snapshot and can increase while bridges archive new images.

## Safe Recovery Boundaries

- Do not manually edit SQLite migration state, version relationships, or derivative job rows.
- Do not delete `mosa.db`, `legacy-json-backup`, or the legacy JSON source to force a retry.
- Preserve the command output and the reported path when migration or verification fails.
- Do not terminate another service only to free a port; choose another port or confirm the service owner first.
- Do not widen Codex source roots, Grok sessions roots, or Cowart discovery roots to solve an import failure.
- Do not bypass Web Capture Token, extension-origin, image-byte, MIME, size, or pixel-count validation to make an ingest request pass.
- Do not pass video assets through sharp or introduce ffmpeg/transcoding to “fix” missing video previews; original media playback is the supported path.

## Before a Code or Deployment Change

Run the repository verification suite:

```bash
npm test
npm run test:performance
npm run lint
npm run check
npm run audit
git diff --check
```

For a change that affects a real library or managed service, also run `npm exec gravityport -- verify --library /absolute/path/to/library` against the intended library and record the bridge health output. Keep the deployment process separate from the default development service so a test server does not replace an active local service.
