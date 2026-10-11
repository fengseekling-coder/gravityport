# Changelog

This file records user-visible changes. Internal deployment notes, local paths, and development handoffs are intentionally not tracked in the public repository.

## Unreleased

- The app has a new icon: the GravityPort mark on a light tile replaces the previous gradient icon on macOS and Windows.
- The rename ships from one source tree as two packages, switched by the `MOSA_RELEASE_PRODUCT` build variable (`GravityPort` by default, `MOSA` for the transition build that moves existing users onto the new feed): it decides the app bundle name, executable name, package output directories, and update/DMG file names (`GravityPort.app`/`GravityPort-darwin-arm64-<version>.zip` vs. the legacy `MOSA.app`/`MOSA-darwin-arm64-<version>.zip` set). Both products stay identical otherwise — same interface, bundle id, settings location, and download page — and both now check for updates at `https://mosa.azhuilab.com/releases/gravityport/latest.json`, where anonymous usage reporting lands as well; the old `/releases/latest.json` path stays frozen for already-shipped versions.
- User-facing names now say GravityPort: the Web Capture extension (0.15.29) shows GravityPort in its extension name, capture panel, toasts, context-menu items, options page, and error messages, while its storage keys (`mosaToken`/`mosaBaseUrl`), pairing identifier, and extension key stay exactly as they were — old extensions keep pairing with the app and renamed extensions keep pairing with older app versions. The CLI gains a `gravityport` command and the help text uses it, with `mosa` still working as an alias of the same binary. The MCP server now reports itself as `GravityPort MCP` (tool names and parameters unchanged), and newly exported C2PA content credentials record `GravityPort` as the claim generator; content credentials exported earlier still read and validate because the provenance format identifiers are unchanged. User-visible library error messages say GravityPort too, while data locations, `MOSA_*` environment variables, and file names are untouched.
- Library search now only matches what you can actually see and would search for: file name, id, prompt, tags, group, category, style, theme, skill, curation note, the user instruction and request prompt, and the provider/model name — plus a readable source name (ChatGPT, Gemini, Flow, Google AI Studio, Codex, Grok, Cowart) you can search by. Internal details an image carries along (original file paths, content hashes, capture channels, page URLs, ids, mime types, dimensions, file sizes, timestamps, status strings) no longer match: searching "copy", "png", "observed" or a folder name no longer floods the gallery with every imported or captured image. Existing libraries re-index once on the first open after updating. The machine-generated part of ids and file names — the import timestamp-and-random suffix, the hashes behind web-capture and Codex/Grok names, collision randoms and UUIDs — no longer matches either, so searching a few characters of it no longer pulls in every image imported at the same moment; pasting a whole id or file name copied from the Inspector still finds exactly that asset.
- The gallery empty state now speaks to the actual situation instead of always claiming "no matching assets": an empty Trash says so (with the 90-day retention note), empty Favorites and Unorganized each get their own line, an empty group explains how to fill it, a brand-new library shows the drag-and-drop import hint as its description, and only a search or filter miss keeps the "clear filters" button. The Inspector no longer claims the library is empty when nothing is selected — it simply says no asset is selected and how to browse to one. Right-clicking an image or a stack outside the current selection now selects it and moves the Inspector to it, exactly like a left click first (including the "discard unsaved changes?" prompt, which on cancel neither switches nor opens the menu); right-clicking a card already in the selection still operates on the whole group. The Move-to-Trash confirmation now names the action on its buttons (取消 / 移到回收站) and asks "移到回收站？"/"把 {count} 个素材移到回收站？" instead of 否/是. In 701–1120px windows with the Inspector open, the focused search panel's text now starts right of the magnifier icon instead of under it, and the dark-theme Inspector copy buttons (Prompt, User instruction) lose their permanent tinted background to match light mode. The Inspector-open button is now labeled "打开素材详情 / Open asset details".
- The Inspector reads as a clear hierarchy again: the file name now sits on its own full-width line above the source line and the 130px preview (long names elide in the middle, keeping the start and the extension, and the favorite star stays on the name line), section titles (Prompt, User instruction, Reference image, Version tree) are 12px semibold in the primary text color instead of 11px pale grey, and the prompt/instruction body text moved up to the same 12px. The prompt and instruction boxes grow with their content and scroll past 120px instead of holding a fixed 120px when empty, an empty reference box collapses to 28px like the version-tree box, and the bottom asset-path capsule drops to the standard 28px control height with its 12px label. Long paths elide in the middle too — the Settings → Storage library path now keeps the library folder name visible at the end instead of cutting the most important part off. The top-bar search field shows the standard 2px focus ring around the whole field (including its floating panel on narrow windows), and the Settings page list keeps at least 12px clear of the "local-first" divider.
- Dialogs, menus, and toasts finish their size convergence to the shared design scale: the Settings dialog is a fixed 720px wide and now grows and shrinks with its content (capped at 540px tall, only the content pane scrolls; its top edge stays put so the page list does not jump when you switch pages), the Model page stacks its status text under the title in full instead of squeezing it into one line, and the About page names the app above the version line; the Trash confirmation is a compact 420px card with a 15px semibold title, a 12px "不再提醒" row, and standard 28px buttons; the right-click menu (and its submenus) tightens to 200px wide with 26px rows and 16px icons; and keyboard focus indicators are unified on the crisp 2px solid focus ring, replacing the faint 3px glow that inputs (including the thumbnail size slider) used before. In 701–1120px windows the thumbnail-size slider track is shorter (72px) so the category and sort dropdowns keep their full labels, and with the Inspector open the collapsed icon rail drops the unlabeled section arrows and keeps a centered add-group button under the existing dividers; sidebar counts, the Inspector "添加标签" button, and the asset path line use darker text colors so every small text passes the 4.5:1 contrast bar in light and dark.
- Corners and spacing across the interface now follow one shared scale: every border radius falls on a 4/6/8/12px ladder (fully-round pills stay fully round) and every gap, padding, and margin sits on a 4px grid, with the old one-off spacing and radius tokens merged into that single set — so panels, controls, and lists line up cleanly instead of sitting a pixel or two off. Dialog, menu, and toast dimensions keep their current geometry for now.
- The interface is now sized for real window sizes instead of the 1920px design board: type across the whole app converges on a five-step scale (11/12/13/15/18px) with three weights, and the outer frames shrink to match — sidebar 280→220px (narrow 240→200px), top bar and viewer header 64→48px, Inspector 320→280px, sidebar nav rows 36→28px tall — so everything reads noticeably more compact at 1280–1440px window widths. All sizes live in shared design tokens; dialogs, menus, and toasts keep their current geometry for now.
- Windows updater groundwork matching the macOS rename support, with no user-visible changes yet: release manifests can declare the Windows payload executable name (`MOSA.exe` by default or `GravityPort.exe`, bound to the matching package filename) and, for Production, the signer thumbprint the installer verifies every payload signature against. The updater now installs under whichever of the two names is already running — an update whose payload ships the other name is renamed into the installed name before anything moves — and a Production payload whose publisher subject differs from a signed installed release is refused, while certificate renewals (same publisher, new thumbprint) and unsigned Preview installs keep updating. Old installs keep their `MOSA.exe` name and folder.
- Internal updater groundwork for the rename and the signed release channel, with no user-visible changes in this release: the macOS updater can now replace the running app under a new name (`MOSA.app` → `GravityPort.app`, refusing to overwrite an app already at the target location and moving the previous app to the Trash only after the new one reports ready, with automatic rollback), release manifests can declare the macOS app name and a production `teamIdentifier`, and Preview installs may now auto-update into a signed Production release (the reverse stays blocked). When the app runs from a Gatekeeper translocation path or a non-writable directory, update checks stop safely and ask the user to move the app into Applications first.
- New installations start their library in `~/GravityPort Library`; existing libraries keep their current location untouched (`~/MOSA Library` stays in use, and a library you moved via Settings → Storage & data keeps its saved location). When the recorded library location is broken, or the library it points to can't be found, the app now shows an error and stops instead of silently falling back to a default and creating an empty library.
- Very wide images in the image viewer no longer cover the previous/next arrows: the picture area now keeps one arrow column clear on each side (44px button plus its 8px edge inset) at every aspect ratio, while portrait images look unchanged. Fullscreen reclaims the space since the arrows are hidden there.
- Toast notifications are pill-shaped with a small icon on the left that tells the kind apart (success, error, plain info) instead of a colored edge, matching the new design's geometry (36px tall, fully rounded). Colors follow the existing theme tokens. Toasts with an "撤销" button keep working and are keyboard-operable.
- The image viewer's fullscreen and the desktop window fullscreen are now the same thing: entering fullscreen from the viewer — or leaving window fullscreen with Esc, the menu, the green button, or ⌃⌘F — keeps both sides in sync; the window follows the viewer and the viewer follows the window. Outside the image viewer the menu's "进入全屏" still only fullscreens the window.
- Fixed the top bar in 701–1120px-wide windows with the Inspector open: the category/sort dropdowns and search could overflow past the main area and hide under the Inspector. The dropdowns now shrink with their text intact (88px floor) and search collapses to an icon entry that expands into a floating panel on focus.
- Moving images to the Trash now matches the new design: the confirmation dialog is a wide card (640px) with the question and the 90-day note in one large type, a 否/是 button pair, and an optional "不再提醒" checkbox that appears only when trashing single assets, multi-selections, or from the image viewer — checking it and confirming skips future confirmations for those three entries. Moving a whole stack to the Trash always keeps its confirmation. A switch on the Settings general page ("移至回收站前确认", Off/On) brings the confirmations back, and trashing from the right-click menu now shows the same "moved to Trash · Undo" toast as the image viewer, so a multi-selection can be restored in one step.
- Web Capture extension 0.15.28: when a ChatGPT image is archived without its prompt, the page hook now keeps a three-minute, 400-frame ring buffer of structural observations from the live traffic that surrounded the capture (SSE patches, WebSocket frames, and the conversation-related `backend-api` responses the page itself loaded) and writes a single redacted record to `chrome.storage.local` 30 seconds later. Only field paths, types, string lengths, and a small allowlist of primitive values are stored — no dialogue text, prompts, URL query parameters, cookies, or tokens — and the buffer is wiped the moment the user turns the switch off. The extension options page now exposes the switch (default off), a count, an export-to-JSON button, and a clear button. About 1 in 10 prompt-bearing captures is also recorded as a `control` sample for diffing. 50 records / 200 KiB per record are retained on the local machine and never sent to MOSA.
- On the first open after updating, ChatGPT generation records whose prompt was blanked by the earlier re-observation bug get it back when it is still recoverable: the record is the image's only generation history entry and the image itself stores the model's caption ("Model caption: …"), so that caption is restored as the record's prompt. Images whose history also holds a duplicate blank record next to an intact one are left alone as before, and the model name is not recoverable and stays blank.
- Fixed a gallery search being silently dropped right after leaving a stack: returning to the library restored the previous selection inside a deferred animation frame, which on Windows could land between the search box registering the query and the app committing it, leaving the gallery on the stale results with no loading state. The selection is now restored synchronously with the exit, so the next search always applies.
- Reopening a ChatGPT conversation no longer blanks the prompt and model of generation records that were already captured with them. When the plugin re-reports an already archived image, the replay carries no live prompt/model data; the generation record now keeps what the live capture stored (prompt, model, user instruction, provider ids, references, and their statuses) and only accepts values that are actually present, so the Inspector stops showing these images without a model or prompt.
- Web Capture extension 0.15.27: ChatGPT leaves internal steps (such as tool calls) out of the conversation list, which made 0.15.26 discard every conversation; a message whose parent is not in the list is now treated as following a skipped internal step, while a parent placed after its child still discards the whole read.
- Web Capture extension 0.15.26: adapted to ChatGPT's new conversation data format (the conversation now arrives as a flat, already-ordered message list with paging instead of a branch tree). Turn numbers are only reported when a single read contains the complete conversation; a longer conversation that only serves its most recent turns reports nothing — a wrong turn number is worse than none — and page stitching is future work. Parsing of the older branch-tree format is unchanged.
- With an MCP server or CLI writing to the same library at the same time, the first app launch after upgrading no longer occasionally fails to open: the one-time upgrade steps (captured-history repair, message-id backfill) now tolerate the concurrent writer and, if one still cannot run, are skipped with a log line and retried on the next open.
- Web Capture extension 0.15.25: while you have a ChatGPT conversation open, the extension reads the structure of the conversation data the page itself loaded and reports to MOSA which generated image file belongs to which turn — message numbers, turn numbers, and file ids only, never conversation text. It sends through the new capture entry `POST /api/ingest/web-capture-turn-bindings`, authenticated with the extension's existing Web Capture token (the client-token endpoint `POST /api/generation-message-bindings` stays reserved for MOSA itself). Edited-away branches, uploaded images, and images the model merely referenced are not reported, the same structure is sent at most once per browser session, and a batch over 2000 entries is dropped whole rather than truncated. A later Inspector update will use these numbers to show "turn N of M".
- Assets can now be moved between stacks in one step (the "cut → paste" move the gallery will use): `POST /api/asset-stacks/move` takes the selected images and a target stack — or none, to un-stack them — and atomically removes them from their current stacks and appends them to the target in order. Original stacks settle exactly as if the images had been removed there: positions compact, the cover reassigns, a stack left with one image dissolves, and moved images are never re-stacked automatically into their old stack. Any invalid image or missing target aborts the whole batch.
- Searching the library now lists every matching image on its own instead of grouping matches into stacks; clearing the search brings stacks back.
- Generation records captured without their ChatGPT message number are now completed automatically: when an existing library is opened, each blank record inherits the message id its image already stored (same conversation only), so the Inspector's turn history can count rounds on complete data. The Web Capture extension also gains a new authenticated endpoint (`POST /api/generation-message-bindings`) through which an open conversation reports which ChatGPT file belongs to which message and turn number — only these numbers and file ids are stored, never any conversation text. Turn numbers follow the conversation structure as of the most recent read, so edits or deletions inside the ChatGPT conversation are reflected on the next sync instead of keeping stale numbers forever.
- The desktop app now creates a fixed, anonymous installation ID on every installation and provides it to the user interface.
- Re-observing an already archived image no longer appends a blank generation record to its history. On upgrade, user instructions that earlier captures overwrote with a message from another turn are restored from the image's first saved prompt, and the duplicate blank generation records from those repeated captures are removed.
- Stacks of images captured from one ChatGPT conversation are now named automatically after the conversation title. Naming happens when the images are captured and, for stacks created before this update, when the old conversation is opened again in the browser. Stacks you named yourself are never renamed, and neither are stacks mixing several conversations or non-capture images.
- Re-observing an already archived ChatGPT image no longer replaces its user instruction with a message from another turn of the conversation.
- Images generated in the same session (a ChatGPT conversation, Flow project, Google AI Studio chat, Gemini chat or Codex task) are now stacked automatically. A session's second image creates the stack, later images join it, and an existing stack that already holds images from the session — including a hand-made one — absorbs them instead. Existing libraries are organized once on upgrade. Images you remove from a stack, or whose stack you dissolve, are never stacked back automatically, and a stack you named keeps its name.
- Web Capture extension 0.15.23: ChatGPT image-to-image turns archive their uploaded reference images again; the user turn is now split into an attachment unit and a text unit, and reference lookup merges every user unit of the same message while the assistant's generated gallery stays excluded.
- Image assets now carry a dominant-color palette: up to 8 colors as hex strings, largest share first, in the asset's `palette` field. New images get it when their thumbnail is generated; existing images get it from their current thumbnail the first time the asset is opened, without regenerating thumbnails. Videos have no palette yet, and the palette is not part of search. The Inspector will show the swatches in a later update.
- Web Capture extension 0.15.22: the ChatGPT page hook now talks to the extension over a private MessagePort instead of a channel name exposed in the DOM, and content scripts only receive the settings they need.
- ChatGPT replies pushed through the streaming conversation request (for example GPT-5.6 Thinking image turns) are now parsed while the stream arrives, so the generation bindings for new images survive the page aborting the request after `data: [DONE]`.
- Fixed navigation being unreachable in windows 701–767px wide. In that range the sidebar collapses into a drawer, but the Inspector stayed pinned open, which hid the drawer button. The Inspector now pins only from 768px up, so in narrower windows it can be closed and the drawer button is available.
- Right-click menus are now consistent everywhere, and every selection action lives in them; the bottom selection bar is gone.
  - Every asset menu uses the same section order: open, copy, organize, history and export, selection, and Trash last.
  - With several assets selected, the menu starts with "N selected" and offers Stack selected, Select all (⌘A) and Deselect (Esc).
  - Inside a Stack, members offer Remove from stack. Right-clicking empty space inside a Stack offers Back to library, Rename stack and Dissolve stack.
  - Right-clicking empty space in Trash offers Empty Trash and no longer shows Add group.
  - Favoriting several assets now follows the whole selection: if every asset is already a favorite, the item removes them all; otherwise it adds them all.
- Manual groups are now called "groups" everywhere. The sidebar heading changed from "素材分类" to "分组", and the English UI no longer mixes "collection" and "group". This also keeps them apart from the asset category field.
- Box (marquee) selection now selects exactly the cards it covers. Previously, when one asset was open in the Inspector, a box selection somewhere else also pulled that asset into the selection. Hold Shift while dragging to add to the current selection instead.
- Secondary text in the light theme now meets WCAG AA contrast (4.5:1). This covers sidebar counts and section titles, the search placeholder, empty-state hints, and the descriptions in Settings. The shared light grey went from `#85858b` (about 3.4:1) to `#67676d` (about 5.2:1 on the gallery background); the dark theme is unchanged.
- The Inspector now follows changes made elsewhere — another window, the MCP server or the CLI. Favorites, tags and other metadata edited outside the current window used to update the gallery card but leave the open Inspector stale until another asset was selected. Starring a gallery card now also lights up the Inspector's favorite button when that asset is open, and keyboard focus stays on the same Inspector control after such a refresh.
- Thumbnails, medium images and previews are now written atomically. If MOSA is quit, crashes or loses power while generating them, the gallery keeps the previous complete images instead of showing a half-written one.
- Web Capture extension 0.15.20 keeps the ChatGPT Model caption when one turn generates several images. ChatGPT now shows them as a gallery of `blob:` images that share one message, so the extension could not tell them apart and saved them without a prompt. It now records which ChatGPT file each `blob:` image was downloaded from (reading only the file id, never the signed URL parameters) and binds each image to its own caption. The per-image request prompt stays empty for batched requests, because nothing in the page reliably ties an image to its request. Gallery images the user never clicked are archived too: a proven gallery `blob:` is read straight from the page-local blob bytes, so the lazy thumbnail does not have to load first, and the large view and its thumbnail still archive once.
- MOSA Desktop now ships the same interface as the web app — the R21 redesign (light theme look, two-column settings dialog, category filter dropdown, Inspector tag overflow with +N, and the keyboard image-preview entry). The duplicated desktop UI copy was removed, so from now on there is a single interface to maintain.
- MOSA Desktop now pairs the fixed allowlisted MOSA browser extensions automatically in the background. Installing/opening the app and loading the official extension no longer requires a native pairing confirmation dialog or manual Token entry; source/headless runtimes remain opt-in.
- Web Capture extension 0.15.5 follows Google Flow's migration to its dedicated `flow.google.com` domain. The provider adapter now runs on both the legacy `labs.google/fx` routes and the new host, the background media probe accepts the relocated `media.getMediaUrlRedirect` endpoint (with or without the `/fx` prefix), and the media-host allowlists include the new origin. Failed media probes now back off per media item instead of re-fetching on every scan, and Flow grid-tile Prompt association uses the thumbnail size floor so small natural-size tiles keep their visible Prompt card.
- Removed the manual Import dialog. Import external images by dragging files or folders into the open gallery (they land in the current group or Stack) or onto a manual group in the sidebar. Pasting an image imports it directly into the current group or Stack. The empty-state Import button, the blank-area "Import asset" context-menu item, and the desktop File → Import menu item (Cmd/Ctrl+N) are gone. Prompt and other metadata are edited afterwards in the Inspector.
- Fixed tags missing from assets loaded through the gallery list: the Inspector showed no tags, and adding a tag there could erase the asset's existing tags.
- Context menus could stop opening, and keyboard shortcuts stop working, after a menu item was activated immediately (for example by assistive technology).
- Opening an asset in the viewer from the context menu no longer leaves its card in the multi-selection, so a later Ctrl/Shift-click or batch action cannot silently include it.
- Dissolving a Stack whose original cover had been removed no longer leaves a stale Stack card in the gallery.
- The Stack header count now updates after members are removed or added in place.
- An open manual group now shows its name as the gallery title and in the asset viewer's scope label, instead of "All assets".
- Version compare selectors keep working after switching versions or any other Inspector refresh.
- Tags can now be removed in the Inspector: each user tag shows a remove button on hover or keyboard focus (always visible on touch). Source tags cannot be removed.
- Changing the library location now refuses the current folder, a folder inside it (or containing it, including case-only path differences), and any non-empty destination before copying anything, so a relocation can no longer copy a library into itself or delete it afterwards.
- Dropping a mix of supported and unsupported files into the gallery or onto a sidebar group now reports the skipped unsupported files in the import summary instead of silently ignoring them.
- Replaced the "Card density" setting with **Settings → Appearance → Card info (Show / Hide)**. Cards are image-only by default; choosing Show now really displays the title and source/date line under each card and re-lays out the masonry gallery for the taller cards (the old "Info" density had no visible effect but still reserved empty space under every card). The choice is remembered; a previously saved density preference is ignored.
- "Export Group" no longer writes local file paths, local directories, `/library/...` links or captured web page/media links into the exported JSON, so the file can be shared without revealing your user name or folder structure. Fields are removed by name only (`*_path`, `*_url`, `*_dir`, `path`, `prompt_file`); your library is not changed.
- MOSA Desktop on macOS now removes leftover `.MOSA-update-*` folders beside `MOSA.app` from failed in-place updates once they are more than 10 minutes old, as it already did on Windows.

## 0.2.1-rc.25 — 2026-09-20 / Release Candidate

### Release integrity / 发布完整性

- Split desktop publishing into explicit Preview and Production tracks. Preview/RC keeps immutable Git provenance, signed release manifests, artifact hashes, exact build identity, and updater rollback without requiring Apple Developer or Windows Authenticode credentials; Production adds those platform trust chains as a deliberate stronger gate.
- Release builds now fail closed unless their source commit is clean, tagged, remotely reachable, and the exact release tag has been pushed. Build identity is carried into the release manifest and verified again after an in-place update reports readiness.
- `releases/latest.json` is now signed with a release-only Ed25519 key whose public key is pinned into the packaged build. Desktop updates and Visual Pack discovery verify that signature before trusting artifact hashes or model-pack metadata, separating release trust from the website/CDN that serves the files.
- macOS Production packaging rejects ad-hoc/non-hardened/wrong-team bundles, requires notarization and Gatekeeper acceptance, and Production in-place updates check the replacement against the installed Developer ID team plus Gatekeeper before replacement.
- Windows Production packaging has an explicit Authenticode path. Production verification pins the expected signer, and Production in-place updates require every executable/native payload (`.exe`, `.dll`, `.node`) to have a valid signature from the installed publisher before the application directory is replaced.
- SQLite schema upgrades create a verified pre-upgrade snapshot before the first mutation and run integrity plus foreign-key verification after migration, retaining the snapshot path in any upgrade failure for deterministic recovery.
- Removed the retired Inspector curation/reuse-context UI strings and the now-unreferenced context-package implementation instead of leaving hidden product surfaces behind.

### Local visual search / 本地视觉搜索

- Wired the first real MOSA-local image-text embedding runtime: a verified SigLIP2 Base int8 visual pack now powers `/api/visual/search`, image-to-image similarity, and near-duplicate/version/Stack candidates through a dedicated fail-closed inference worker process. No Ollama, Python, or network access is required at inference time.
- Moved ONNX Runtime and the tokenizer runtime out of the core desktop bundle and into the optional, platform-specific Visual Pack. The macOS arm64 pack remains below the 512 MiB gate while `MOSA.app` actively rejects accidental rebundling of those visual-only dependencies.
- Added an optional packaged visual smoke that proves the built `MOSA.app` can load the external verified pack, start its real ONNX worker, build embeddings, run text-to-image search, and return image-to-image neighbors.
- Settings can now install, update, cancel, and remove the optional Visual Pack without exposing model paths or download URLs to the renderer. Downloads come only from MOSA's fixed first-party origin, are staged with disk-space checks, pin the pack manifest from the release feed, verify every file by size and SHA-256, preserve the previous revision on failure, and restart MOSA only after a verified install/removal.
- Fixed the macOS Desktop/Web Capture KeepAlive races around startup and in-place self-update. Normal Desktop startup publishes a short-lived PID/start-identity handoff marker before runtime startup. During self-update, the detached helper takes ownership of that same backward-compatible marker before the old Desktop releases port 43517 and keeps it through replacement/readiness, so an already-loaded supervisor cannot reclaim the production runtime during the gap. The supervisor stands down before spawning or gracefully yields an already-running child, while stale markers and PID reuse fail open to normal background recovery.
- Added macOS in-app self-update support. Packaged MOSA can consume a version-bound arm64 ZIP from the existing first-party release manifest, download it to private userData staging with exact size/SHA-256 verification, stop its owned runtime, replace `MOSA.app` through a detached helper, relaunch the new build, require renderer/runtime readiness, and roll back automatically if replacement or relaunch fails. The release build now emits the matching update ZIP plus manifest metadata alongside the DMG.
- Added a canonical desktop release-manifest writer for release automation. It emits the same `platforms.*` schema consumed by Desktop, hashes real artifacts, refuses mixed-version macOS/Windows entries, removes legacy `artifacts.*`, preserves `visualPacks`, and validates the result with the production update parser before publishing.
- Settings now measures real runtime availability instead of reporting a placeholder: states are `not-installed`, `disabled`, `loading`, `ready`, `runtime-unavailable`, and `error`.
- Background embedding indexes assets incrementally with content-hash staleness detection; deleted assets are pruned from the derived index and a crash of the inference worker degrades to explicit unavailability rather than wrong results.

### Search & Stack reliability / 搜索与堆叠稳定性

- Custom Stack names are now searchable from the collapsed gallery while raw asset and Stack-interior searches keep their existing member-level semantics.
- Whole-Stack Trash operations now preserve and reconcile confirmed progress when a later batch request is interrupted; outcomes without a response are reported as unresolved instead of being mislabeled as failures or retried blindly.
- Local context-menu refresh events are scoped to the project that was mutated so a long-running operation cannot reconcile its result into a different project after navigation.

### Performance / 性能

- Added an indexed short-Unicode candidate table for one- and two-character non-ASCII search terms, with schema backfill and write-path synchronization, avoiding full-library `LIKE` scans for common short CJK queries.
- Collapsed gallery paging now uses a dedicated no-filter fast path and Stack annotations aggregate only the Stacks relevant to returned rows instead of scanning every active Stack member.
- The 50k performance gate now separately covers cold search, short CJK search, and a mixed library with 2,000 five-member Stacks.

### Web Capture activity / 网页收录状态

- Settings now shows the browser extension's bounded pending/retrying queue summary together with recent Runtime ingest outcomes and Prompt-availability status.
- The extension reports only redacted queue diagnostics to the authenticated loopback Runtime; raw Prompt text, page/media URLs, and media bytes are excluded from this status channel.
- A Settings retry action requests the extension to drain its existing durable queue; MOSA does not create a second delivery queue or blindly duplicate failed captures.

### Library backup & restore / 素材库备份与恢复

- Added explicit CLI backup, backup verification, and restore commands for completed SQLite libraries. A backup includes the SQLite snapshot, managed originals/derivatives, reference attachments, and the migration-completion marker.
- Backups are published only after MOSA integrity checks pass and a SHA-256 manifest has been written; verification detects missing or modified files before restore.
- Restore requires an explicit empty destination and rebases managed absolute paths into that destination before running the normal library verifier. Large media hashes are streamed instead of loaded into memory as one buffer.

### Gallery import & navigation / 图库导入与导航

- Dropped or picked assets now import into the currently active stack instead of landing as ungrouped library items.
- Removed the sidebar saved-filter presets. Existing project-local filter names are no longer restored into the gallery.
- Sidebar navigation now clears hidden facets, so switching primary view, source, or group does not keep leftover hidden filters.

### Inspector / 检视器
-
- Inspector version history now includes a two-version comparison view for stored media and persisted Prompt/style/theme/ratio/group/category/tag/change-summary fields. It compares existing records only and does not infer missing generation facts.

### Retrieval foundation / 检索基础
-
- Added a reproducible retrieval acceptance baseline with enforced lexical cases plus diagnostic conversational, semantic, cross-language, and visual-content probes. This makes the case for any future embedding layer measurable instead of assuming that a model is required.
- Added conservative Chinese conversational query planning: recognizable phrases such as “找一下之前做过的…” are reduced to design terms that actually exist in the local short-term index before entering the existing strict search path. The acceptance set now guards these supported conversational queries while leaving semantic and visual probes diagnostic.
- Added an audited design-vocabulary normalization layer for multi-signal paraphrases and cross-language designer terminology. On the current synthetic acceptance probes it closes the measured text-semantic gap without adding a model runtime; visual-content probes remain intentionally unsolved and separate.
- Expanded visual-retrieval diagnostics to use real generated pixel fixtures with composition facts withheld from searchable metadata, so future image-model experiments cannot accidentally pass by reading Prompt text.
- Added a model-candidate gate for local visual retrieval covering product-use licensing, optional model-pack footprint, memory, cold start, query/index latency, exact vector-search latency, and pixel-grounded retrieval quality. Also added a 50k × 512 exact-vector benchmark so an ANN dependency is introduced only if measured scale requires it.
- Added an offline visual-model-pack manifest/verifier and CLI command. Packs pin embedding dimension, preprocessing metadata, license/product-use declaration, byte sizes, and SHA-256 for every file; verification rejects traversal, symlinks, tampering, and oversized packs before any runtime integration.
- Added the model-neutral visual relationship engine foundation: a versioned userData-side embedding index, exact image-neighbor lookup, stable visual API contracts, safe derived-index cleanup, and advisory near-duplicate/version/Stack candidate classification. No candidate mutates library organization or provenance automatically.
- Added the model-neutral background embedding worker contract with incremental current/stale checks, pause/resume/stop behavior, per-asset failure isolation, and stale-vector pruning so a future local model can backfill the library without blocking normal MOSA use.
- Added a validated image/text embedding-provider boundary and text-to-image visual search API. Provider model id/revision/dimension must match the indexed vector space exactly, startup is lazy, runtime shutdown closes the provider, and MOSA can now expose visual text search without coupling product APIs to a specific model runtime.
- Made MOSA-local the explicit desktop visual-model path: Electron now discovers and verifies optional model packs under userData, persists local enablement/selection, and exposes a Settings status surface without an Ollama dependency. Installed-model and compatible-runtime readiness remain separate so unsupported builds fail closed.

## 0.2.1-rc.14 — 2026-09-16 / Release Candidate

### Drag & drop import / 拖放导入

- Dropping files and whole folders onto the gallery or the import card now imports every supported image/video in one batched queue, with progress in the gallery status line and per-batch failure isolation instead of "first file only".
- Unsupported files inside dropped folders are skipped and reported as an informational count; a folder full of non-media files no longer exhausts the import budget.
- The file picker accepts multi-selection; single files keep opening the familiar import flow.
- Holding a card drag and leaving the MOSA window hands the selected assets to the OS as a native file drag (Electron desktop), so assets can be dropped into Finder, browsers, and other apps.

### Security & privacy / 安全与隐私

- Web Capture pairing now requires an explicit native confirmation dialog in front of the user; headless CLI runtimes deny pairing by default (`MOSA_WEB_CAPTURE_PAIR=auto` opts in for automation).
- The CLI server no longer prints the management token into redirected output logs; interactive terminals keep the URL handoff.
- Anonymous usage telemetry can be disabled locally with `MOSA_DISABLE_TELEMETRY=1`.
- Web capture upload sessions are bounded (8 concurrent) to cap temp disk usage.

### Reliability / 稳定性

- The JSON fallback store now serializes every per-asset metadata/lifecycle write through one lock, closing a race where a metadata edit could resurrect an asset that was just moved to the Trash.
- Group hard-delete and asset creation now stage file removals/copies so interrupted operations roll back or clean up instead of leaving half-deleted or half-written files.
- Windows update apply keeps the previous installation parked for recovery until the updated app's next boot sweeps it, and the rollback deletion is explicitly scoped to the replacement payload.
- `npm run check` now also syntax-checks `.cjs` sources (the desktop preload was previously outside its coverage).

## 0.2.1-rc.13 — 2026-09-13 / Release Candidate

### Codex default source alignment / Codex 默认来源对齐

- MOSA now treats Codex's own `CODEX_HOME` as the single default root for Codex-owned local data. When `CODEX_HOME` is unset, the default remains `$HOME/.codex` on macOS/Linux and `%USERPROFILE%\.codex` on Windows.
- Automatic Codex image archive reads `generated_images` under that root, while Prompt/model/provenance matching reads `sessions` under the same root. Cowart's MOSA canvas and registry defaults are rebased from that same Codex root as well.
- Codex automatic archive now treats `generated_images` and `sessions` as two coordinated sources: standard generated files remain primary, while inline `image_generation_call` / `image_generation_end` results can recover an image when Codex did not persist the advertised generated file.
- Session JSONL processing was redesigned as an incremental byte-indexed reader. After the initial scan, an active runtime reads only newly appended complete records instead of reparsing whole session files on every bridge reconciliation.
- Inline session images are size-limited, base64-validated, binary-signature checked, staged only inside MOSA's private recovery directory, copied into the library, and then removed. Session `saved_path` values do not widen MOSA's filesystem trust boundary.
- Removed the MOSA-invented Windows `Documents\\codex` default and project-directory image scanning path. Custom source variables remain explicit overrides, but they no longer redefine Codex's defaults implicitly.
- Runtime startup resolves the Codex/Cowart source locations once and passes the same paths to every integration, preventing image, session, and Cowart components from drifting onto different roots.
- Codex automatic archive now reconciles two native sources: files under `<CODEX_HOME>/generated_images` and image-generation events appended to `<CODEX_HOME>/sessions`, so result-only generations can still be recovered when Codex does not persist the image file.
- Session JSONL processing is incremental by byte offset, merges duplicate call/end surfaces by generation identity, carries incomplete records across scans, and bounds inline-result recovery without rescanning whole sessions on every poll.
- Recovered session results are validated into a MOSA-private temporary area, copied into the library, then removed; they are never treated as external trusted roots or later hard-linked back to Codex session data.

## 0.2.1-rc.12 — 2026-09-12 / Release Candidate

### Startup critical-path redesign / 启动关键路径重构

- Shows a lightweight MOSA shell immediately while local runtime ownership and SQLite startup continue in parallel.
- Moves Codex, Grok, Cowart, and Cowart discovery scans off the runtime readiness path and isolates integration startup failures from the core library.
- Probes local runtime discovery ports concurrently while preserving primary-port fail-closed ownership rules.
- Runs independent first-view renderer requests in parallel so the gallery is no longer serialized behind project/version reads.

## 0.2.1-rc.11 — 2026-09-11 / Release Candidate

### Live drag preview / 实时拖拽预览

- Replaced the invisible single-asset drag state with a lightweight thumbnail preview that follows the pointer in real time.
- Added a short lift-in animation and a compact count badge for multi-selection drags without delaying pointer tracking or changing Stack/group drop semantics.

## 0.2.1-rc.10 — 2026-09-11 / Release Candidate

### Drag feedback cleanup / 拖拽反馈清理

- Removed the empty floating drag ghost for single-asset Stack and group drags.
- Reduced multi-selection drag feedback to a compact count badge while keeping drop-target highlighting and Stack/group behavior unchanged.

## 0.2.1-rc.9 — 2026-09-11 / Release Candidate

### Stack drag authentication validation / 堆叠拖拽鉴权验收

- Rebuilt the macOS application from the post-PR #78 `main` baseline so the installed desktop bundle and its local runtime include the authenticated drag-to-stack recovery shipped in `cbd4516`.
- Preserved the browser-session capability and runtime-supervision fixes while giving the corrected build a distinct release-candidate version for reliable rollback and field diagnosis.

## 0.2.1-rc.8 — 2026-09-11 / Release Candidate

### Desktop runtime ownership and drag workflow recovery / 桌面运行时接管与拖拽工作流恢复

- Hardened macOS background-runtime supervision so the desktop app can safely take ownership of the correct local MOSA runtime without leaving stale process state behind.
- Restored authenticated drag-to-stack creation and drag-into-existing-stack workflows while preserving the local runtime capability boundary.
- Added a first-party HttpOnly browser-session capability for direct loopback Web UI launches so state-changing actions no longer fail with `Unauthorized MOSA client.` when the page is opened without a fragment token.
- Fixed drag-to-group target lifetime so dropping assets onto manual groups or Unorganized continues to work after drag visual state is cleared.
- Expanded end-to-end regression coverage to exercise direct drag Stack creation from a bare local URL, Stack reordering, and browser mutation authentication.

## 0.2.1-rc.7 — 2026-09-11 / Release Candidate

### Runtime integrity, group workflows, and release validation / 运行时完整性、分组工作流与发布验证

- Hardened local runtime integrity with authenticated state-changing API requests, PID-reuse-safe runtime ownership, transactional metadata and generation-lineage updates, stricter Trash path boundaries, and isolated derivative processing so native image decoder failures cannot take down the main MOSA runtime.
- Strengthened Web Capture and gallery synchronization under concurrency, including serialized chunk uploads, safer ingest-slot handoff, revision-aware reconciliation, and protection against stale refreshes overwriting newly appended gallery pages.
- Expanded manual group management with drag-to-group, batch move/remove, persistent ordering and colors, group merge, group statistics, normalized case-insensitive naming, and safer version-family moves.
- Aligned source, Electron, E2E, and packaged-app validation with the runtime client-capability model across macOS and Windows, including authenticated packaged smoke coverage.
- Added a durable third-party notice crediting APSAL Open `v0.14.0` as a design influence on MOSA's recipe snapshot model, while explicitly separating that attribution from MOSA's own PolyForm Noncommercial licensing.

## 0.2.1-rc.6 — 2026-09-10 / Release Candidate

### Gallery stability and dependency hardening / 图库稳定性与依赖加固

- Stabilized infinite-scroll pagination so adding the next gallery page no longer temporarily collapses the virtual scroll extent and nudges the viewport.
- Hydrates all currently visible virtual gallery cards in the same paint cycle while keeping background hydration bounded, eliminating the visible placeholder-to-card ripple during fast paging.
- Hardened gallery interaction and navigation race handling, including incremental Masonry corrections that preserve stable per-column placement rather than globally rebalancing loaded cards.
- Updated Sharp to the release carrying the current libheif security fixes used by MOSA's packaged image pipeline.

## 0.2.1-rc.5 — 2026-09-08 / Release Candidate

### Desktop distribution, large-library navigation, and synchronization / 桌面分发、大图库导航与同步

- Added the first-party desktop release manifest and update-check flow. Packaged Windows builds can download the matching portable ZIP in-app, verify its size and SHA-256 digest, replace the application directory through a detached helper, and roll back on replacement failure.
- Added a macOS DMG distribution path with drag-to-Applications replacement behavior while keeping release-grade Developer ID signing and notarization fail-closed behind `desktop:release`.
- Added Stack Inspector behavior, windowed gallery navigation, large-gallery virtualization, and safer selection/navigation handling so loaded pages and scroll state survive common library transitions.
- Reworked library synchronization around revision-aware incremental change reconciliation instead of routinely reloading the entire loaded gallery window after one asset changes.
- Hardened desktop runtime ownership and stale-runtime handoff, Web Capture delivery/retry behavior, capture lookup performance, Windows packaging/runtime paths, file reveal on spaced Windows paths, and Inspector/context-submenu rendering.
- Aligned packaged anonymous install/activity reporting across website, GitHub, and directly shared packages while keeping development and QA launches excluded.

## 0.2.1-rc.4 — 2026-09-02 / Release Candidate

### Library organization and desktop branding / 素材整理与桌面品牌

- Added an **Unorganized / 未整理** library view. It shows assets that are neither in a manual group nor part of a Stack, so the items that still need curation have a dedicated place.
- Refined sidebar navigation so selecting a primary view, source, or manual group establishes one clear library context while other filters can still refine it.
- macOS and Windows desktop packages now use the MOSA app icon instead of Electron’s default icon.
- Build identity is generated only inside each package, preventing an outdated tracked identity file from being included in a new build.

## 0.2.1-rc.3 — 2026-09-02 / Release Candidate

### Desktop upgrade reliability / 桌面升级可靠性

- A packaged desktop upgrade now waits for a KeepAlive-managed local MOSA service to finish restarting and report the exact new build identity, then opens directly instead of requiring a second manual launch.
- The handoff continues to fail closed if a different, same-version, newer, unverified, QA, development, or explicit-port runtime is encountered.

## 0.2.1-rc.2 — 2026-09-02 / Release Candidate

### Desktop upgrade reliability / 桌面升级可靠性

- A newer packaged MOSA build can now take over a verified, strictly older local runtime for the same library, then reconnect only after the replacement reports the new build identity.
- Development, QA, explicit-port, same-version, newer-version, and unverified local runtimes remain fail-closed and are never stopped automatically.
- Startup errors no longer expose internal build fingerprints or Git identifiers to users.

## 0.2.1-rc.1 — 2026-09-02 / Release Candidate

### Reliability and privacy / 可靠性与隐私

- Packaged desktop builds now report the same minimal anonymous install/activity UUID regardless of whether the app package came from the MOSA website, GitHub, or a directly shared copy.
- Anonymous usage reporting is independent from update-manifest parsing, retries with the same installation UUID after transient failures, and persists the local UUID/profile atomically.
- Development and QA launches remain excluded from production usage metrics.

## 0.2.0 — 2026-08-28

> **Local visual memory for AI creation.**
> 把 Codex、ChatGPT、Grok 与 Cowart 中的创作结果，连同可用的 Prompt、来源和版本，留在自己的电脑上。

### New / 新增

- **More creation sources, one local library.** Add optional Web Capture for ChatGPT, Gemini, Flow, and Google AI Studio; local Grok Build CLI image and video archiving; and safer project-local Cowart canvas discovery alongside Codex image collection.
- **A library built for reuse.** Add verified JSON-to-SQLite migration, FTS5 search, stable pagination, WebP previews and thumbnails, tags, favorites, and provenance while preserving originals.
- **Version history that keeps the why.** Add asset-based recipe version trees, REST and MCP version APIs, and bilingual UI flows for browsing versions and creating the next one.

### Removed / 移除

- Removed controlled insertion from MOSA into Cowart canvases to focus this release on asset collection, archiving, and version management. Cowart canvas archiving (collecting snapshots into the library) is unchanged.

### Web image capture

- Added an optional Chrome extension that captures ChatGPT-generated images with message-scoped Prompt and provenance data.
- Added a loopback-only ingest endpoint and bridge status endpoint. Web capture is disabled until `MOSA_WEB_CAPTURE_TOKEN` is explicitly configured.
- Added image-byte, MIME, size, pixel-count, origin, and request-envelope validation for browser-extension ingestion.
- Stores the extension address, Token, and auto-capture preference in Chrome local storage rather than synchronized storage.
- Hardened extension reload handling so startup context loss is reported reliably and temporary settings failures cannot re-enable auto-capture or overwrite the saved preference.
- Added Gemini, Flow, and Google AI Studio page support to the optional Chrome extension. These sites capture only user-visible generated images and page provenance; they do not inspect session APIs, credentials, or hidden prompts.

### Reliability and privacy / 可靠性与隐私

- Web Capture is loopback-only and disabled by default. It requires an explicit ingest Token and approved extension origin, then validates image bytes, MIME type, size, pixel count, and request shape.
- Migration verifies records, original-image hashes, and library structure before SQLite becomes authoritative; JSON remains a backup rather than a second live store.
- Grok and Cowart imports preserve their source boundaries, report health and errors, and deduplicate without widening the permitted local paths.
- Add Node 22 baseline, source checks, dependency audit scripts, and GitHub Actions CI for the public source.

### macOS desktop

- Added an Apple Silicon Electron shell that opens the existing MOSA Web UI without adding an AI model, cloud service, or frontend rewrite.
- Added verified attach, owned-runtime, and conflict modes for the local MOSA service, preserving external services and stopping only runtimes owned by the desktop app.
- Added Electron Forge packaging with ASAR and unpacked native dependencies for `better-sqlite3` and `sharp`.

### Windows desktop preview

- Added a shared Electron platform boundary so the renderer, local runtime, storage, Web Capture pairing, and most desktop behavior remain one implementation across macOS and Windows.
- Added the `win32-x64` Forge target with Windows-native `better-sqlite3` and Sharp runtime selection, ASAR native unpacking, Windows executable/path resolution, and Windows packaged-smoke support.
- Added Windows path safety for drive-letter paths, UNC paths, and cross-drive containment; source defaults now flow through a centralized source-location resolver instead of scattered platform assumptions.
- Added a Windows CI lane for x64 packaging, platform/path contracts, Electron E2E, and packaged smoke.
- Verified on a real Windows machine that MOSA starts successfully, renders the shared library and Inspector, and automatically collects Codex assets. The Windows shell keeps the native title bar while hiding Electron's visible application-menu row and retaining keyboard accelerators.

### Licensing / 许可

- Version 0.2.0 and later are source-available under the PolyForm Noncommercial License 1.0.0. Noncommercial personal, educational, research, hobby, modification, and distribution uses remain permitted; commercial use requires separate written authorization.
- [v0.1.0](https://github.com/fengseekling-coder/mosa/releases/tag/v0.1.0) remains the final MIT-licensed public source snapshot. Existing MIT copies retain their original rights.

### Known limits / 已知限制

- **Desktop builds are not a signed release.** macOS arm64 and Windows 10/11 x64 development/package targets exist, but no signed public desktop installer is published for 0.2.0. Windows is currently Preview/Testing; installer/signing/automatic-update work is still pending.
- **Windows source coverage is not complete yet.** Codex automatic collection has been verified on a real Windows machine; Grok and Cowart Windows source discovery remain unverified until their actual local layouts are confirmed.
- **No cloud by default.** MOSA provides no remote sync, embedded AI model, semantic search, or automatic library upload.
- **Capture is deliberately conservative.** Web Capture needs a locally loaded extension; when MOSA cannot confidently match generation context, it records the Prompt as unavailable instead of guessing.

## 0.1.0 - Final MIT-licensed source snapshot

- Added a local-first visual library that preserves prompts, image metadata, source paths, and provenance alongside each asset.
- Added automatic Codex image reconciliation and provenance capture from local image-generation records.
- Added Cowart canvas synchronization, source-aware reuse, and deduplication for images returned to the canvas.
- Added a browser UI with search, filters, metadata editing, English and Chinese interfaces, and a local MCP server.
- Added a reproducible judging path using tracked sample records and the `npm test` suite.

## 2026-07-19 - UI polish

- Fixed blank space below gallery cards and normalized vertical spacing.
- Truncated long collection names in the sidebar while preserving their full value in the hover title.
- Kept the complete README interface screenshot and removed two redundant detail screenshots.
