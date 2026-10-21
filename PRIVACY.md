# Privacy

Last updated: 2026-10-21

GravityPort is a local-first creative asset library. It does not operate a GravityPort cloud library, advertising system, or remote user account. Packaged desktop builds send the bounded anonymous usage signal described below through a bodyless request to the same first-party release endpoint used for update metadata; usage reporting and update-manifest parsing are separate operations.

## Data GravityPort Reads

Depending on the features you enable, GravityPort may read:

- generated media under the configured Codex generated-image root;
- matching local Codex session records used to recover Prompt and provenance;
- media and matching `chat_history.jsonl` records under the configured Grok sessions root;
- the dedicated GravityPort Cowart canvas and the canvases of projects where Cowart was launched from Codex, found in local Codex session records from the last 14 days;
- ChatGPT web images and message-scoped context sent by the optional Chrome extension, including from conversations you used in the ChatGPT desktop app (see [ChatGPT desktop app conversations](#chatgpt-desktop-app-conversations));
- user-visible generated images from Gemini, Flow, and Google AI Studio sent by the same extension; Gemini may additionally send the nearest preceding visible `user-query` within the generated image's local message structure, Flow may send one uniquely anchored visible Prompt card, and AI Studio may send the nearest preceding visible user Prompt turn in the same chat session. Each is marked as unverified;
- the ChatGPT desktop app's local state file `.codex-global-state.json` in the Codex home folder (by default `~/.codex`), read only for the ChatGPT conversation ids of desktop-app chats and the id of the last prompt sent in each, so the Web Capture extension can capture images from those conversations.

GravityPort does not intentionally scan Downloads, Desktop, unrelated project folders, arbitrary browser pages, or source roots outside the documented allowlists.

## Data GravityPort Stores

The selected local GravityPort library can contain:

- original image or video bytes;
- WebP previews and thumbnails;
- Prompt and user-message text;
- hashes, dimensions, timestamps, source paths, source type, model/tool information, and provenance;
- version relationships, tags, archive state, and group metadata;
- for web capture, provider/page URL, capture time, capture mode, extension version, Prompt provenance/source/scope, a GravityPort-derived Prompt-priority value used only to prevent lower-quality provider fields from overwriting better ones, observed generation status when exposed by the page/runtime, and bounded source-occurrence history; ChatGPT additionally records conversation/message identifiers, the conversation title shown by ChatGPT (used to name the conversation's stack), and observed image-tool call, generation-call, response, or provider-asset identifiers when those values are explicitly present in the page/runtime data and, when the live page stream exposes it, the Prompt text of the image-tool call (what ChatGPT's chat model sent to the image generator), stored separately from the caption Prompt;
- generation events separately from deduplicated media assets. A generation event can contain a GravityPort-created `capture_context_id`, provider runtime identifiers when observed, a verification level, Prompt fields and scope, observed generation status, references, and evidence. A GravityPort capture-context ID is never represented as a provider generation-call ID;
- for ChatGPT desktop app capture, a small `.chatgpt-desktop-sync.json` file in the library folder holding, for at most 200 conversations, the conversation id, the times it was last used and last synced, a retry count, a hand-out expiry time, and a truncated SHA-256 hash of the id of the last prompt sent in it — never prompt text.

Reference images identified by Web Capture are stored as private generation-record attachments under the selected GravityPort library. They are content-hash deduplicated and may be linked into the subsequent generated asset's recipe snapshot, but they are not ordinary assets and therefore do not appear in the gallery, search, recent items, or asset totals. GravityPort does not infer the purpose or rights of a reference from its pixels.

A recipe may also record rights declarations for the reference images it used: copyright state, portrait-consent state, redistribution state, an attribution string, and the purposes the reference may or may not serve. These are entered by the user, not detected. They can concern identifiable third parties, so an attribution name is personal data and the library should be treated accordingly. GravityPort never infers consent: every field starts at `unknown`, and silence is never recorded as permission.

The library is stored on the user's machine. GravityPort does not upload it to a GravityPort-operated service.

User-initiated exports of group metadata (the sidebar group context-menu "Export Group" JSON download) stay metadata-only: the exported file contains file names, Prompts, tags, groups, categories, ratings, business fields, source types, and timestamps, and the export strips every local file path and directory (managed originals, previews, import source paths), every `/library/...` URL that only resolves against the local GravityPort server, and web-capture page/media links such as `page_url` and `source_media_url`, so the file can be shared without disclosing your user name or directory structure. Fields are dropped by name only — any field, including a business field, whose key ends in `_path`, `_url`, or `_dir`, or is named `path` or `prompt_file`, is dropped, while all other fields are kept verbatim.

## Anonymous Usage Metrics

Desktop builds send minimal anonymous usage metrics so the project can measure whether releases are actually being installed and retained. This telemetry is limited to the bounded fields below and is not exposed as an in-app preference; it can be disabled locally by launching GravityPort with the `MOSA_DISABLE_TELEMETRY=1` environment variable, for example:

- macOS, for one launch: run `MOSA_DISABLE_TELEMETRY=1 /Applications/GravityPort.app/Contents/MacOS/GravityPort` in Terminal (use `MOSA.app/Contents/MacOS/MOSA` for an install that still carries the old name). To cover launches from the Dock or Finder until the next restart, run `launchctl setenv MOSA_DISABLE_TELEMETRY 1` and then reopen the app.
- Windows: run `setx MOSA_DISABLE_TELEMETRY 1` once in Command Prompt or PowerShell, then start GravityPort again. The setting applies to every later launch for your user account; remove it in System Properties → Environment Variables.

GravityPort stores a random UUID in Electron's local `userData` directory. The UUID is generated by GravityPort and is not derived from a device serial number, account, filesystem path, hardware fingerprint, Prompt, asset, or source-tool identifier.

Every desktop launch makes sure this UUID exists: it is created locally on the first launch and reused unchanged afterward; the current interface does not display it. When telemetry is disabled (`MOSA_DISABLE_TELEMETRY=1`), or in a development or QA run, the UUID is only stored locally and is never sent. The set of reported fields is unchanged.

At most once per calendar day in the `America/Los_Angeles` time zone, packaged GravityPort Desktop may send a bodyless HTTPS request to `https://mosa.azhuilab.com/releases/gravityport/latest.json` containing the following bounded fields. Versions released before the rename send this request to the legacy address `https://mosa.azhuilab.com/releases/latest.json`. While the app remains open, it rechecks eligibility every 15 minutes. This usage request is independent of where the installer was obtained (for example, the GravityPort website, GitHub, or a directly shared package):

- event type: `first_launch` or `daily_active`;
- telemetry protocol version: `2`;
- the random installation UUID;
- GravityPort version;
- operating-system family: macOS, Windows, or other;
- CPU architecture such as `arm64` or `x64`.

GravityPort does not attach library contents, asset counts, Prompt text, filenames, local paths, browser history, provider conversation identifiers, email addresses, names, or account data to this request. A failed usage request is not counted as a successful usage report. Manual update checks do not create extra activity reports. Upgrading from the previous 24-hour protocol permits one report under the new protocol while preserving the existing installation UUID.

The website can also retain a short campaign label such as `ref=reddit_codex` on a download URL so aggregate download traffic can be attributed to the page or creator that referred it. GravityPort does not require a login for attribution.

## Desktop application updates

GravityPort Desktop reads `https://mosa.azhuilab.com/releases/gravityport/latest.json` when you check for or install an application update, and also silently when the app window opens if more than 24 hours have passed since the last check. Versions released before the rename still read the legacy address `https://mosa.azhuilab.com/releases/latest.json`. If you explicitly choose **Download and update**, macOS and Windows builds download only the platform-specific update artifact advertised by that manifest from `https://mosa.azhuilab.com/downloads/`. GravityPort does not attach your library contents, images, videos, Prompts, provenance records, search queries, library paths, or Visual Pack embeddings to the update download. Update files are staged locally under Electron `userData`, verified by declared byte size and SHA-256, and used only to replace the application itself; the library folder (`MOSA Library`, or `GravityPort Library` for new installs) and its original assets remain outside the application replacement transaction.

## No model downloads

Local visual search is not offered in the app for now: Settings has no Models tab, and GravityPort does not download a Visual Pack or any other model.

## Optional C2PA helper download

C2PA Content Credential export can use an optional `c2patool` helper pack. The desktop installer component is implemented and tested, but no desktop UI entry point ships it to end users yet; when a future release wires that entry point, this section describes exactly what will happen. GravityPort reads the signed first-party release manifest used by application updates — signature verification is mandatory in code, not optional — and downloads the platform-specific helper only from `https://mosa.azhuilab.com/downloads/helper-packs/c2patool/`. These requests do not include your images, videos, Prompts, provenance records, library paths, search queries, signing keys, certificates, or credentials. The downloaded helper is verified locally by pinned file sizes and SHA-256 hashes before it becomes active.

GravityPort does not download `c2patool` directly from GitHub on end-user machines. Upstream binaries and license files are consumed only by GravityPort's release preparation process, then redistributed as a pinned first-party helper pack.

## Web Capture Chrome Extension

The optional extension:

- defaults automatic capture to off for a new installation and opens its settings page so the user can review the capture disclosure before enabling it; upgrades preserve the user's existing local preference;
- runs only on the ChatGPT, Gemini, Flow, and Google AI Studio domains declared in its manifest;
- observes ChatGPT page and generation-response data to associate an image with the correct message-scoped Prompt and event-scoped conversation identifier and, when an image-generation result follows a user turn containing uploaded images, may archive those uploads as private reference attachments before the generated asset; provider asset identifiers are retained per observed reference usage when available, so a later generation can be compared against earlier Generation Events without turning that comparison into a confirmed relation;
- reads, while a ChatGPT conversation is open in a tab — one you opened, or one the extension opened for ChatGPT desktop app capture (described below) — the structure of the conversation data the page itself loaded: the message order, roles, and image file ids of the displayed branch, so GravityPort can label which turn each archived image belongs to. Only identifiers and numbers are reported: the conversation id, the user-message id of the producing turn, the turn index and total turn count, and image file ids. This turn report never contains conversation text, prompts, titles, or image or download URLs, and never covers edited-away branches. The same structure is sent at most once per browser session per conversation, only to the paired loopback GravityPort, and not at all without a paired token;
- reports the title of the ChatGPT conversation open in the tab, together with its conversation id, so GravityPort can name the stack of images captured from that conversation. The title is read from the page title or from the open conversation's sidebar entry; placeholder titles such as "New chat" are skipped, and it is capped at 200 characters. The title is also attached to images captured from that conversation. It is reported, while the extension is paired and automatic capture is on, when the conversation is opened, when its title changes, and when automatic capture is switched on; with automatic capture off it is not reported on its own, though manual saves still carry it. GravityPort keeps it only when it already holds images from that conversation; otherwise it is discarded;
- records ChatGPT web observations as `observed`, not as provider-API-verified provenance. GravityPort may locally score relation candidates from reference identity, modification-like user instructions, same-conversation order, and timing, but these remain `inferred` candidates until the user confirms or dismisses them; message order alone never creates a parent/child generation relation;
- may fetch generated image and supported video bytes from the OpenAI- and Google-hosted asset domains declared in its manifest; redirect destinations are re-validated against the same media-host allowlist, and the original plus final media URL may be retained as local provenance evidence;
- sends captured data only to the configured loopback GravityPort address;
- receives its Web Capture Token through a loopback pairing request that GravityPort Desktop accepts only from the two fixed allowlisted GravityPort extension origins; Desktop pairing is automatic and silent, while headless CLI runtimes keep pairing disabled by default unless their owner explicitly opts in;
- stores the GravityPort address, Web Capture Token, auto-capture preference, and a bounded retry queue for unresolved capture jobs in `chrome.storage.local`, not synchronized storage. The queue is retried by a Chrome alarm and is removed after GravityPort acknowledges the capture or after its bounded retention period. Later terminal status or higher-quality Prompt metadata updates the existing queued job rather than creating an independent stale replay. While a ChatGPT desktop app conversation is being captured, the current job (conversation id, window and tab ids, start time) is kept in `chrome.storage.session`, which Chrome holds in memory and clears when the browser exits;
- reports a bounded retry-queue diagnostic snapshot to the paired loopback GravityPort runtime so the desktop Settings view can show pending/retrying capture work. This snapshot contains at most 20 queue entries and is limited to a local capture key, provider, media kind, Prompt-status label (not Prompt text), generation-status label, queue timestamps, retry-attempt count, and the bounded local error message. It does not include Prompt/user-message text, page URLs, media URLs, cookies, account identifiers, or captured media bytes. The runtime keeps this diagnostic state in memory; it is refreshed by the extension and is not a second delivery queue. The same status request also tells GravityPort whether the extension can take a ChatGPT desktop app conversation right now (a true/false flag), and GravityPort's reply can carry one conversation id for it;
- accepts a local retry-request counter from GravityPort Desktop. The counter does not contain capture content and does not move ownership of queued jobs into the desktop runtime; the extension remains the only component that replays its durable queue;
- temporarily stores page-local `blob:`/Base64 media needed by queued jobs in the extension's local IndexedDB. Image media is stored as a Blob referenced by the retry queue; large page-local videos are stored as bounded ordered Blob chunks rather than one in-memory object. These records are deleted after GravityPort acknowledges the capture, when the user/extension aborts the transfer, or when the associated bounded retry job expires or is evicted;
- transfers large page-local generated videos to the extension worker in bounded chunks and later sends the queued chunks to GravityPort through its local upload-session endpoints rather than one whole Base64 JSON message. Remote HTTPS videos continue to stream directly to the GravityPort upload session without being retained as one whole video in extension memory;

Its manifest host permissions are limited to the following explicit hosts/patterns: `chatgpt.com`, `chat.openai.com`, `*.oaiusercontent.com`, `images.openai.com`, `*.blob.core.windows.net`, `gemini.google.com`, `labs.google`, `flow.google.com`, `aistudio.google.com`, `*.googleusercontent.com`, `*.ggpht.com`, `storage.googleapis.com`, `generativelanguage.googleapis.com`, `flow-content.google`, plus loopback `127.0.0.1` and `localhost` for delivery to GravityPort. The Azure Blob host is used for provider-served media bytes and is not a GravityPort-operated endpoint. Its API permissions are `storage`, `contextMenus`, and `alarms`; the minimized windows used for ChatGPT desktop app capture are opened and closed through `chrome.windows`, which needs no additional permission.

For captured videos, GravityPort may store media dimensions, MIME/type information, byte size, and `durationSeconds` when the provider-visible media metadata exposes a usable duration. This field is local provenance metadata and is not transmitted to a GravityPort cloud service.

When updating from an earlier prerelease extension, existing settings may be read once from Chrome synchronized storage, copied to local storage, and removed from synchronized storage. The known prerelease development Token is discarded rather than migrated.

The extension does not request or store an OpenAI API Key or ChatGPT password. It operates inside the user's existing browser session, so each provider and its asset hosts remain governed by their own privacy terms.

For ChatGPT late-caption recovery, the page-world hook may make a same-origin request for the currently open conversation using the browser session already available to that page. The page-world hook does not read, copy, store, post, or replay ChatGPT Authorization headers or related authentication request headers. The only place the extension handles a ChatGPT credential is the check described under [ChatGPT desktop app conversations](#chatgpt-desktop-app-conversations): there the background worker obtains a short-lived access token from `https://chatgpt.com/api/auth/session` and uses it for one request to `chatgpt.com`, without storing it or sending it anywhere else. If the same-origin request is not sufficient, the image remains archived and the Prompt may remain unavailable.

On Gemini (`gemini.google.com`), it may additionally capture only the nearest preceding rendered `user-query` associated with a visible image inside a `model-response`. It skips inputs, editors, hidden content, unrelated page regions, credentials, cookies, and API keys. This text is marked `provider-visible-prompt` and is not verified as the prompt actually executed for generation.

On Google AI Studio (`aistudio.google.com`), it may additionally capture only the nearest preceding rendered user Prompt turn within the same `ms-chat-session` as a visible generated image. It skips controls, inputs, editors, hidden content, model thoughts, other sessions, cookies, credentials, and API keys. This text is marked `provider-visible-prompt` and is not verified as the prompt actually executed for generation.

On Flow (`labs.google` / `flow.google.com`), it also may capture the one visible Prompt card structurally associated with a visible generated-image group, but only when the card has a unique nearby `Reuse Prompt` control. This text is marked `provider-visible-prompt`, is not verified as the prompt actually used for generation, and is never collected from an input, editor, hidden content, cookies, credentials, or the page as a whole.

## ChatGPT desktop app conversations

The ChatGPT desktop app (the same app that now hosts Codex) does not save chat images or chat text on your computer, so GravityPort cannot import them from disk. Instead, GravityPort notices which desktop conversation you just used and asks the Web Capture extension to capture that conversation from `chatgpt.com` in your browser.

While the Codex source is enabled, the local GravityPort service checks the desktop app's state file `.codex-global-state.json` in the Codex home folder (`$CODEX_HOME`, by default `~/.codex`) about every 10 seconds. From that file GravityPort uses only two things: the ChatGPT conversation ids that the desktop app's chats are bound to, and, for each conversation you sent a prompt in, the id of the last prompt message. Prompt text, the composer history, account details, and the rest of the file are not used or stored. A conversation counts as used when it first appears in the file or when the id of its last prompt changes. The first time GravityPort reads the file, every conversation listed there is marked once, so existing desktop chats get a single catch-up check.

GravityPort keeps its progress in `.chatgpt-desktop-sync.json` in the library folder: for at most 200 conversations, the conversation id, the times the conversation was last used and last synced, a retry count, a hand-out expiry time, and a truncated SHA-256 hash of the last prompt message id — not the id itself and no prompt text. The file never leaves your computer.

A conversation is handed out only after it has been quiet for 90 seconds, one at a time, in GravityPort's reply to the paired extension's regular local status report (about once a minute), and only to an extension that has automatic capture turned on and no desktop sync window already open. The extension reports back only the conversation id and an outcome (`captured`, `no-images`, `failed`, or `timeout`); a conversation is tried at most three times each time it is used.

The extension first checks whether the conversation contains a generated image. Its background worker asks `https://chatgpt.com/api/auth/session` for the access token of the ChatGPT account your browser is signed in to, using the browser's existing ChatGPT cookies, and sends that token once, as the Authorization header of a single request to `https://chatgpt.com/backend-api/conversation/<id>`, because ChatGPT does not answer this request with cookies alone. The token is held in memory for that request only; it is not stored and is never sent to GravityPort or to any host other than `chatgpt.com`. The rest of the session response, such as your account name or email address, is not used. The conversation response is examined only for whether a non-user message contains an image; nothing from it is stored or sent to GravityPort.

If the conversation contains no generated image, the extension reports `no-images` and opens nothing. Otherwise — or when the check could not be completed — it opens `https://chatgpt.com/c/<id>#gravityport-desktop-sync` in a new minimized, unfocused browser window, one window at a time; the window may briefly appear in your taskbar or window list. The page is then captured exactly like a ChatGPT conversation you reopened yourself, with the data described under [Web Capture Chrome Extension](#web-capture-chrome-extension): images, your messages as Prompt context, conversation and message identifiers, turn structure, and the conversation title. ChatGPT's live-only image caption and image-tool Prompt are not available this way. Once capture has been quiet for 10 seconds (at least 20 and at most 110 seconds after the page loads), the extension closes the window. A window still open after about 150 seconds is closed and reported as timed out, and closing the window yourself ends that attempt.

These requests use your browser's own ChatGPT session and remain governed by OpenAI's terms, as if you had opened the conversation in the browser yourself; GravityPort itself does not contact OpenAI. If the browser is signed in to a different ChatGPT account than the desktop app, the conversation cannot be read and nothing is captured.

To stop this, turn off automatic capture in the extension, or disable or remove the extension; GravityPort then hands out no conversations. To stop GravityPort from reading the desktop app's state file at all, disable the Codex source with `MOSA_DISABLE_BRIDGES=codex`, which also stops Codex image import. Deleting `.chatgpt-desktop-sync.json` resets the tracking; GravityPort recreates it and checks every listed conversation once more.

## Pinterest connection (not yet available)

GravityPort Desktop can optionally connect to your Pinterest account so you can browse your own boards and Pins inside the app. The feature is implemented but not yet available: the sidebar entry stays marked as unavailable until Pinterest approves production API access, and GravityPort does not access Pinterest at all until you connect.

Once connected, the app reads the following through the official Pinterest API with read-only scopes: your Pinterest username; the name, description, Pin count, and cover of your boards, including secret boards; and the title, description, link, and image addresses of the Pins on those boards. This content is shown live on your computer only. It is not saved into the GravityPort library and is not uploaded to GravityPort-operated servers. To avoid repeated requests, the app keeps responses in an in-memory cache for at most 5 minutes and clears it when you disconnect or quit the app. Pin images load directly from Pinterest.

Access tokens are stored only on your computer, as an atomically written, permission-restricted (mode 0600) file in Electron's local `userData` directory. During authorization, the GravityPort-operated service only forwards the authorization code or refresh token, together with the app secret, to Pinterest to obtain tokens, and returns the result directly to your computer; the app itself never holds the app secret. The service does not store authorization codes or tokens and does not write them to logs.

You can disconnect Pinterest at any time in GravityPort settings, which deletes the token file stored on your computer. You can also revoke GravityPort's access under the authorized apps in your Pinterest account settings.

## Feedback

The app never collects feedback in the background: feedback is submitted only when you press **Send** on the feedback page in GravityPort settings. The app forwards one request to the first-party feedback collection service at `https://mosa.azhuilab.com/api/feedback`.

When you press **Send**, the app submits:

- the feedback text you wrote (at most 5000 characters);
- a contact address you optionally fill in, used only to reply to you (at most 200 characters);
- the interface language (Chinese or English);
- the feedback type you chose (bug, idea, or other), app version and build commit identifier, operating system and its version, and CPU architecture type;
- if you tick **Include diagnostic log** (unticked by default), the app's recent runtime log.

The diagnostic log is a bounded in-memory ring buffer of the local service's recent warnings, errors, and informational lines. You can review its full content in the app before sending — what you see is exactly what is sent. Usernames in library and home file paths, tokens and other long secrets, and email addresses are masked, and any line that might contain prompt or instruction text is removed entirely. The text is redacted again when the request is submitted, and the submission is capped in size.

The app does not send and does not store with the feedback: the installation ID, your assets, prompts, or the library location. The local log records only the outcome status of a submission, never its content.

On the server, feedback is stored in a private directory on the collection service and is visible only to the developer through a logged-in admin page; it is used only to reply to you and to improve the product, not for advertising, and is never shared with third parties. The server does not store IP addresses — an IP is used only in memory, temporarily, to prevent submission abuse. To have feedback you sent deleted, write to [fengseekling@gmail.com](mailto:fengseekling@gmail.com) and mention roughly when you sent it.

## Network Boundary

The GravityPort service binds to `127.0.0.1` and is not designed for public exposure. GravityPort does not add remote synchronization. The desktop shell's only GravityPort-operated analytics signal is the bounded usage metadata sent through the separate HTTPS request described above.

The outbound connections described in the sections above are: the update and usage endpoints under `mosa.azhuilab.com`; the Pinterest authorization relay under `mosa.azhuilab.com` together with Pinterest's own authorization and API endpoints when you connect Pinterest; and the feedback collection service when you press **Send** on the feedback page. None of them carries your library contents, and Pinterest browsing results are not sent anywhere by GravityPort. The Web Capture extension's requests to `chatgpt.com` for ChatGPT desktop app conversations are made by your browser with your own ChatGPT session; GravityPort itself does not contact OpenAI.

Codex, ChatGPT, Grok, Cowart, Chrome, Pinterest, and any AI or image-generation provider used before an asset reaches GravityPort are separate products. Their own network behavior and privacy policies still apply.

## User Control

- In the desktop app, choose **Settings → Storage → Change** (next to Storage location) to move the local library to an empty folder. GravityPort copies the existing assets and metadata, switches the saved location only after the copy succeeds, and then restarts.
- `MOSA_LIBRARY_DIR` remains an explicit runtime override. When it is set, it takes precedence over the saved desktop location and the in-app move control is disabled.
- Disable web capture by disabling or removing the extension. Turning off its automatic capture stops automatic capture and ChatGPT desktop app capture, and the separate conversation-title reports, while manual saves still work. GravityPort Desktop creates its own Web Capture Token in Electron `userData` and pairs automatically, so leaving `MOSA_WEB_CAPTURE_TOKEN` unset does not disable web capture there; a standalone `npm start` runtime keeps web capture disabled while `MOSA_WEB_CAPTURE_TOKEN` is unset.
- Disable a source bridge by not configuring or running the corresponding source tool, or by listing it in `MOSA_DISABLE_BRIDGES` (comma-separated: `codex`, `grok`, `cowart`, `cowartDiscovery`). Disabling `codex` also stops GravityPort from reading the ChatGPT desktop app's state file.
- Pinterest stays disconnected until you connect it in Settings → Connect; disconnecting deletes the tokens stored on your computer, and until then GravityPort never accesses Pinterest.
- Nothing is submitted through the feedback page until you press **Send** there; leaving **Include diagnostic log** unticked sends no log.
- Back up the library before migration, repair, or manual removal.
- Do not commit the library, Tokens, Prompts, session records, or generated media to the source repository.

GravityPort archive actions are organizational and do not promise secure erasure. Filesystem backups, browser data, source-tool histories, and copied media must be managed separately.

## Security and Questions

Report vulnerabilities through [SECURITY.md](SECURITY.md). For privacy questions that are not security reports, use the contact routes in [SUPPORT.md](SUPPORT.md) without including private user data.
