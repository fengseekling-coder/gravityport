# GravityPort Operations Guide

This guide covers local operation of an existing GravityPort installation. It does not replace the product overview in `README.md`, and it uses placeholders instead of a maintainer's personal paths or ports.

## Operating Modes

### Development service

For a checkout and its sample data, start the default local service:

```bash
npm ci
npm start
```

The default address is `http://127.0.0.1:43517`. This process starts the Codex bridge, Grok media bridge, Cowart bridge, Cowart discovery, and derivative worker. New media is collected only while the service is running.

### Managed local service

For a persistent local installation, use the operating system's process manager and configure a dedicated local port and library explicitly:

```bash
MOSA_LIBRARY_DIR=/absolute/path/to/library \
MOSA_PORT=PORT \
MOSA_PROJECT_DIR=/absolute/path/to/mosa \
MOSA_WEB_CAPTURE_TOKEN='replace-with-a-random-secret' \
MOSA_WEB_CAPTURE_ORIGINS='chrome-extension://replace-with-extension-id' \
npm start
```

Choose a port that is not already used by another GravityPort or legacy service. Bind only to `127.0.0.1`; GravityPort is not designed for public exposure.

For a standalone runtime started with `npm start`, `MOSA_WEB_CAPTURE_TOKEN` and `MOSA_WEB_CAPTURE_ORIGINS` remain required when the web-capture extension is used. The origins value is a comma-separated list of exact `chrome-extension://<id>` or `moz-extension://<id>` origins. When the Token is unset, web capture must remain disabled; when the origin is absent, extension requests must be rejected. Never put the Token in a tracked file, command transcript, issue, or log.

The packaged/Desktop runtime supplies these values automatically: it persists one random Web Capture Token inside Electron `userData`, authorizes only GravityPort's two exact Chrome extension origins (the unpacked development ID and the Chrome Web Store ID), prefers port `43517`, and falls back through the reserved local discovery ports when another listener owns the preferred port. The extension verifies `/api/health`, pairs only from one of those approved `chrome-extension://` origins, and caches the resolved local address and Token in `chrome.storage.local`.

### Desktop shell

Run the desktop shell from a checkout or build one of the currently approved desktop targets:

```bash
npm run desktop:start

# macOS arm64
npm run desktop:make

# Windows 10/11 x64
npm run desktop:package:windows
npm run desktop:make:windows
```

The desktop packaging commands for both macOS and Windows require Node.js 22.x. The repository pins `22.23.1` in `.nvmrc` and `.node-version`; use the version-manager file supported by your environment before packaging. The pre-scripts deliberately fail before Forge runs when another Node major is active, avoiding incomplete packages that can occur with the current Forge/Packager chain on Node.js 24. On Windows, use the same pinned Node 22.x for the initial `npm ci` as well: the clean `windows-2022` CI lane installs successfully with that runtime, while Node 24 can resolve npm's implicit native rebuild through Electron's node-gyp toolchain and require an otherwise-unnecessary ClangCL setup. General non-desktop runtime development can still use the broader root `engines.node` range.

For reproducible native packaging, build macOS on macOS and Windows on Windows (the Windows CI job is the canonical clean builder). Sharp installs its native runtime through OS-specific optional packages, so a clean macOS `npm ci` does not install `@img/sharp-win32-x64`. macOS-to-Windows cross-packaging is therefore a developer-only path unless that target package is provisioned explicitly; the Forge prune hook fails closed with an actionable error instead of producing a package with a missing native runtime.

The desktop shell defaults to `~/GravityPort Library` on `127.0.0.1:43517`, the same local service used by browser capture; a machine that already has a `~/MOSA Library` keeps using it, and only a machine without any library starts fresh with `~/GravityPort Library` (the rule lives in `lib/library-location.mjs`). A user can move an owned desktop library from **Settings → Storage & data → Change location**; the selected empty directory is persisted in the desktop user-data area and becomes the library root after GravityPort copies the existing library and restarts. Override the port with `MOSA_DESKTOP_PORT` only when a separate runtime is intentional, and the library with `MOSA_LIBRARY_DIR`. An explicit `MOSA_LIBRARY_DIR` always takes precedence over the saved desktop location and disables in-app relocation.

At startup, the desktop shell verifies the service identity and library path. Ordinarily, an already-running matching external service can be attached without taking ownership, while an empty port starts an owned runtime. Packaged macOS startup has one deliberate exception for the Web Capture KeepAlive handoff: as soon as the Desktop process wins Electron's single-instance lock it writes a 30-second `.mosa-desktop-starting.json` marker into the selected library. The marker is bound to the Desktop PID plus process-start identity and is ignored/removed when expired, dead, or PID-recycled. The macOS Web Capture supervisor checks that marker before spawning and while its child runtime is active; an active child receives one graceful `SIGTERM` and the supervisor enters its existing takeover grace. macOS self-update reuses the same marker protocol for compatibility with an already-loaded supervisor: after spawning the detached update helper, the old Desktop binds a 90-second handoff marker to the helper PID/start identity before releasing its runtime. The helper keeps that marker across old-app exit, extraction, replacement, relaunch, and the unchanged 45-second readiness window; the relaunched app therefore prefers an owned runtime without trying to create a competing marker. On success the helper clears the marker only after readiness is reported; on rollback it clears the marker before restoring the previous app. Packaged Desktop also has a narrow verified-owner retirement fallback so an older matching primary runtime can be retired only after re-verifying the live service, library lock owner, PID/start identity, and requested build. It never escalates to `SIGKILL`. If a marker owner dies or the marker expires, the supervisor resumes normal background fallback automatically. A foreign listener or a GravityPort service using another library remains a conflict and is never terminated.

On macOS, closing the last window keeps the Desktop-owned runtime available so the app can be reopened from the Dock; an explicit application quit stops an owned runtime and releases its library lock. On Windows, closing the last window quits the app because GravityPort does not expose a tray re-entry point; an owned runtime is stopped through the same graceful shutdown path.

Packaging names follow the `MOSA_RELEASE_PRODUCT` switch in `scripts/release-product.mjs`: left unset it selects the GravityPort product, and setting it to `MOSA` builds the transition package that moves existing users onto the new update feed. GravityPort builds write the macOS application under `out/GravityPort-darwin-arm64/` and the Windows package directory under `out/GravityPort-win32-x64/` with `GravityPort.exe` at its root; the `MOSA` transition build uses `out/MOSA-darwin-arm64/`, `out/MOSA-win32-x64/`, and `MOSA.exe` instead. `desktop:make` packages the macOS app, creates `out/make/update/darwin/arm64/GravityPort-darwin-arm64-<version>.zip` for in-app updates, and then creates `out/make/dmg/darwin/arm64/GravityPort-darwin-arm64-<version>.dmg` for first install/manual replacement. The update-ZIP builder prints its exact byte size, SHA-256, and `platforms.macos` release-manifest patch. The DMG contains exactly `GravityPort.app` plus an `Applications` symlink, and the build verifies the mounted image before returning success. The bundle identifier (`com.azhuilab.mosa`) is stable across versions, while the app file name follows the switch; the updater accepts both `MOSA.app` and `GravityPort.app` (Windows: `MOSA.exe` / `GravityPort.exe`), so a Windows install that auto-updated from a pre-rename build keeps its `MOSA.exe` name. GravityPort Library data and Electron user-data live outside the application bundle and are not replaced by either update path.

Desktop publishing has two explicit distribution tracks. `desktop:release` is an alias for the macOS **Preview/RC** path: it still requires clean/tagged/remote Git provenance, a pinned Ed25519 release-manifest trust root, structural package verification, packaged smoke, and a valid macOS code signature, but ad-hoc signing is allowed and Apple Developer/notarization credentials are not required. `desktop:release:production` is the separate production path; it requires Developer ID signing, Hardened Runtime, notarization, stapling, and Gatekeeper acceptance before the update ZIP or DMG is accepted. On Windows, `desktop:release:windows` is the unsigned-capable Preview portable-ZIP path, while `desktop:release:windows:production` requires Authenticode configuration and verifies every executable/native payload signer. `desktop:make*` remains the ordinary local-development packaging path.

Windows 10/11 x64 is currently a **Preview / testing** target. A real Windows-machine smoke cycle has verified application startup, SQLite, Sharp, the shared library/Inspector UI, and automatic Codex collection. The Windows shell keeps the native title bar but hides Electron's visible application menu row; the underlying menu remains installed so keyboard accelerators continue to work. Grok and Cowart Windows source discovery remain unverified until their real local source layouts are confirmed.

Windows Preview builds may remain unsigned and SmartScreen may warn about an unknown publisher. Production builds require `MOSA_WINDOWS_SIGNER_THUMBPRINT` plus a supported signing source (`WINDOWS_CERTIFICATE_FILE` + `WINDOWS_CERTIFICATE_PASSWORD`, `WINDOWS_SIGN_WITH_PARAMS`, or `WINDOWS_SIGN_HOOK_MODULE_PATH`). macOS Preview DMGs use the ad-hoc signing path and are not notarized; only `desktop:release:production` requires Apple Developer credentials. A conventional Windows installer and background login launch remain separate release work.

Packaged Windows builds support an explicit in-app update flow for portable ZIP releases. Release builds pin an Ed25519 release-manifest public key in their build identity, so the main process verifies `latest.json` before trusting any artifact hash or distribution mode. It then requires the artifact platform/architecture/filename to match the advertised release — the optional `platforms.windows.payloadExeName` (`MOSA.exe` by default, or `GravityPort.exe`) is bound to the package filename, shipping as `MOSA-` / `GravityPort-win32-x64-<version>.zip` respectively — downloads only from the fixed GravityPort origin, and verifies the declared byte size/SHA-256. The updater always installs under whichever of the two whitelisted names the running executable has (an unrecognized name stops the update), so an update whose payload ships the other name is renamed into the installed name inside the extracted payload before anything moves, keeping the install directory and every relaunch path on the current name. After the old main process exits, the detached helper also waits for residual processes whose executable still lives inside the current GravityPort install directory before attempting replacement; bounded `Move-Item` retries remain as a second defense against short antivirus/indexer handle retention. The helper itself is created with `CREATE_NO_WINDOW`, while the relaunched GravityPort GUI process uses its normal visible-window lifecycle rather than inheriting hidden-window semantics. Preview updates rely on the signed manifest plus post-launch build-identity verification. Production updates additionally require `platforms.windows.signerThumbprint` in the signed manifest and verify every `.exe`, `.dll`, and `.node` in the replacement payload against it: each file must carry a valid Authenticode signature whose thumbprint equals the pinned one, and an installed release that is already validly signed pins only the publisher subject (so a renewed certificate with a rotated thumbprint keeps updating, while a different publisher is refused); an unsigned Preview install may cross into Production once, trusted only through the signed manifest. The relaunched app must report the exact expected version, Git SHA, UI fingerprint, runtime fingerprint, and distribution before the transaction is accepted; otherwise rollback restores the previous directory.

### C2PA / Content Credentials helper

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

Packaged macOS arm64 builds use the same Settings update control and signed release-manifest trust root. The trusted main process accepts only `platforms.macos` entries whose identity is exactly `macOS` / `arm64` plus a filename bound to the optional `appName` field (`MOSA.app` by default, or `GravityPort.app`, shipping as `MOSA-` / `GravityPort-darwin-arm64-<version>.zip` respectively), downloads only from `https://mosa.azhuilab.com/downloads/`, rejects redirects, verifies declared size/SHA-256, and stages the ZIP under Electron `userData`. Preview replacements must have the expected bundle/version and pass `codesign --verify`, but do not require Developer ID or Gatekeeper acceptance. Production replacements additionally require Hardened Runtime, Gatekeeper acceptance, and a TeamIdentifier chain anchored in the signed manifest: the manifest's `platforms.macos.teamIdentifier` must match the payload, and an installed app that already carries a Developer ID team must carry the same one (an ad-hoc/preview install without a team is allowed to cross into production exactly once, via the signed manifest). The updater can replace the app under its current name or across names (`MOSA.app` → `GravityPort.app`); a cross-name update refuses to overwrite an app already present at the target location and moves the previous app to the Trash only after the replacement reports readiness, rolling the whole change back otherwise. When the running app sits in a Gatekeeper translocation path or a directory it cannot write to, update checks report `install-location-unsupported` and the UI asks the user to move the app into Applications first. The relaunched app must report the exact signed-manifest version, Git SHA, fingerprints, and distribution. Missing readiness, identity drift, an early crash, or any replacement failure restores the previous app and relaunches it automatically.

Publishing a macOS in-app update therefore requires uploading the generated update ZIP to `/downloads/<filename>` and adding the builder's generated object under `platforms.macos` in `releases/gravityport/latest.json`. The legacy `releases/latest.json` path stays frozen for clients released before the rename and never receives the renamed releases. Increment the semantic/prerelease version for every published build; update availability is version-based rather than Git-SHA-based.

The release monitor must not construct `latest.json` with its own schema. Use `scripts/prepare-desktop-release-manifest.mjs` as the canonical manifest writer. Release builds must be created with `MOSA_RELEASE_MANIFEST_PUBLIC_KEY` (or `_FILE`) so the public Ed25519 key and key id are pinned into `app/build-identity.json`; manifest publishing separately requires `MOSA_RELEASE_MANIFEST_PRIVATE_KEY` (or `_FILE`). Keep the private key outside the repository and deployment web root. `MOSA_RELEASE_DISTRIBUTION=preview|production` is also bound into build identity and the signed manifest. Downgrading a Production install back to Preview stays blocked; Preview installs may cross into Production because that bridge is what lets existing users adopt the Developer-ID-signed release in place (the manifest's `platforms.macos.teamIdentifier`, required for production, keeps that trust anchored to the signed manifest). Pass `--mac-app-name GravityPort.app` (and, for production builds, `--mac-team-identifier <10-char id>`) to publish the renamed package. The writer computes artifact byte sizes/SHA-256 from the real files, binds Git/UI/runtime/distribution identity, preserves the current `visualPacks` declaration, signs the complete manifest, verifies its own signature with the packaged public key, and then passes it through the production parser. Every release must also come from a clean commit carrying `v<version>`, reachable from a remote branch, with the exact tag already pushed to `origin`.

Example for a macOS-only rc release while preserving the current Visual Pack declaration:

```bash
node scripts/prepare-desktop-release-manifest.mjs \
  --version 0.2.1-rc.16 \
  --previous /path/to/current/latest.json \
  --mac out/make/update/darwin/arm64/GravityPort-darwin-arm64-0.2.1-rc.16.zip \
  --notes-zh "<最终中文发布说明>" \
  --notes-en "<final English release notes>" \
  --output /path/to/staging/latest.json
```

### Optional Visual Pack publishing

Visual search model/runtime bytes are not shipped inside the core desktop package. Build one platform-specific pack per supported target and publish its directory tree under the fixed first-party origin:

```bash
node scripts/build-visual-model-pack.mjs --source <candidate-source> \
  --runtime-target darwin-arm64 \
  --output <release-root>/siglip2-base-patch16-224/<revision>/darwin-arm64
```

Use `--runtime-target win32-x64` for the Windows pack. The command prints a `release_manifest_patch.visualPacks.<target>` object containing the exact pack id/revision, total payload bytes, `model-pack.json` byte size and SHA-256, and license metadata. Upload the output directory byte-for-byte to `/downloads/visual-packs/<id>/<revision>/<target>/`, then merge that generated entry into the official `releases/gravityport/latest.json`.

Do not publish the release-feed entry until every referenced file is already present at the fixed download origin. The desktop installer rejects arbitrary renderer-provided URLs, redirects, unsupported targets, mismatched runtime architecture, insufficient disk space, manifest/file size drift, SHA-256 drift, and packs that fail final `verifyVisualModelPack()` validation. Updates download beside the working revision and select the new revision only after verification, so a failed update does not destroy the last known-good pack.

### Optional C2PA helper pack publishing

`c2patool` is also kept outside the core desktop package. Prepare each target on a **native runner** so the preparation step can execute `c2patool -V` before accepting the binary. Supply the upstream license files together with the extracted official executable:

```bash
npm run prepare:c2pa-helper -- \
  --binary /path/to/c2patool \
  --version <upstream-version> \
  --license /path/to/LICENSE-MIT \
  --license /path/to/LICENSE-APACHE \
  --output <release-root>/c2patool/<version>/darwin-arm64
```

On Windows run the same command with the native `c2patool.exe`; the output target becomes `win32-x64`. The preparer verifies the executable's reported version, copies the executable and supplied license material, writes `helper-pack.json`, hashes every file, verifies the completed pack, and prints a `helperPacks.c2patool.<target>` release-manifest patch.

Upload the output byte-for-byte under:

`/downloads/helper-packs/c2patool/<version>/<target>/`

Then merge the generated patch into the signed first-party `releases/gravityport/latest.json`. Publish the files **before** publishing the release-feed reference. The desktop installer only accepts the signed GravityPort release feed — release-manifest signature verification is mandatory in code — and the fixed `https://mosa.azhuilab.com/downloads/helper-packs/c2patool/` origin; it rejects redirects, path traversal, unsupported targets, invalid sizes/hashes, symlinks, missing license/notice material, and packs whose final verification fails. Installation is staged beside the last working helper and swapped only after verification. The installer module (`desktop/c2pa-helper-installer.mjs`) is implemented and covered by tests, but no desktop UI entry point invokes it yet; releases must not describe helper installation as an end-user feature until that wiring ships.

The current upstream binary distribution uses a macOS universal archive and a Windows x64 MSVC archive. GravityPort does not download those GitHub archives at runtime; upstream artifacts are an input to the release-preparation pipeline only. Client machines download only the GravityPort-pinned helper pack from the first-party origin.

## Library Migration

Before a first migration, leave the source JSON directory untouched and use a dry run:

```bash
npm exec gravityport -- migrate --dry-run --library /absolute/path/to/library
```

The examples use the `gravityport` command name; the legacy `mosa` name still works and points at the same `bin/mosa.mjs` entry.

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

Before adding embeddings or another search model, run the reproducible retrieval acceptance set:

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
MOSA_LIBRARY_DIR=/absolute/path/to/library node scripts/migrate-codex-hardlinks.mjs
```

Set `MOSA_PROJECT_ID` to select a project other than `default`; the pass covers archived assets too. It only swaps a library file for a hard link when the Codex original still exists, sits on the same filesystem, and hashes identically, so it never rewrites image bytes. Every other asset is reported under `skipped` with its reason. New imports are already hard-linked on ingest and need no maintenance.

## Derivative Repair

Previews and thumbnails are persistent SQLite jobs. Rebuild only when repair or backfill is needed:

```bash
npm exec gravityport -- thumbnails rebuild --library /absolute/path/to/library
```

The command is resumable. It does not modify original image bytes.

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

- `storage` is `sqlite` only after a completed migration.
- Codex, Grok, and Cowart report `enabled: true`; watcher/polling availability depends on the local source directories.
- Codex image and session sources should resolve beneath the same `CODEX_HOME` unless an explicit per-source override is configured. With no overrides, use `<CODEX_HOME>/generated_images` and `<CODEX_HOME>/sessions`; when `CODEX_HOME` is unset it defaults to the user's `.codex` directory.
- Codex bridge diagnostics expose independent `watchingImages` and `watchingSessions` flags. `pendingSessionResults` is the number of generation events still waiting for a standard file or recoverable session result, and `lastSessionBytesRead` shows how many JSONL bytes the most recent incremental scan actually consumed.
- Standard files under `generated_images` are always preferred. Session-result recovery is only a fallback when the standard file is unavailable; recovered bytes are validated and staged inside GravityPort's private assets area, then copied into the library and removed from staging.
- `grok.sessionsDir` points at the configured Grok sessions root (default `~/.grok/sessions`).
- `lastError` is empty or `null`.
- `cowartDiscovery` is enabled when the service can read local Codex session records.
- `webCapture.enabled` is true only when the active runtime has a local ingest Token and at least one approved extension origin. A standalone `npm start` runtime gets those values from explicit configuration; Packaged Desktop provisions them automatically for its fixed extension identities. Its providers list should contain `chatgpt`, `gemini`, `flow`, and `google-ai-studio`.

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

For a change that affects a real library or managed service, also run `gravityport verify` against the intended library and record the bridge health output. Keep the deployment process separate from the default development service so a test server does not replace an active local service.
