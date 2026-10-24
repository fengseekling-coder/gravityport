# Third-party notices

This file records upstream projects that materially informed GravityPort's design or implementation, the main third-party components shipped inside the GravityPort desktop app, and third-party models or runtimes that GravityPort redistributes in its optional packs. It is separate from GravityPort's own license terms.

The desktop packages carry the full license texts for the third-party code they ship in a `licenses` folder: `GravityPort.app/Contents/Resources/licenses/` on macOS and `resources\licenses\` next to `GravityPort.exe` on Windows. It holds Electron's `LICENSE` (as `ELECTRON-LICENSE.txt`), Chromium's `LICENSES.chromium.html`, the GNU LGPL and GPL version 3 texts, and `THIRD_PARTY_LICENSES.txt`, which lists every npm package in the interface bundle and in the desktop runtime with its license text, followed by each library packaged with libvips and its license. Packaging generates the folder with `scripts/third-party-licenses.mjs` and refuses to finish if any shipped package lacks a license text.

## APSAL Open

GravityPort's recipe snapshot model was informed by the immutable, reproducible creative-record concepts in **APSAL Open**.

- Project: `henyjone/apsal-open`
- Reference release: `v0.14.0`
- Reference commit: `823f1cbc5557310fa092620391181c1d13485b15`
- Upstream code license: Apache License 2.0
- Upstream author: HenyJone / APSAL Open
- Source: <https://github.com/henyjone/apsal-open/tree/v0.14.0>

The influence is at the design level. In GravityPort, the resulting recipe snapshot system records a frozen generation recipe with content-derived identity, Prompt and recipe digests, normalized reference declarations, provenance, and change lineage. The current GravityPort implementation lives in `lib/recipe-snapshot.ts` and the corresponding storage/API layers.

GravityPort does not vendor, bundle, execute, or depend on APSAL Open source code. No APSAL source files are distributed as part of GravityPort. GravityPort's own source remains licensed under the repository's [PolyForm Noncommercial License 1.0.0](LICENSE); this notice does not relicense GravityPort under Apache-2.0.

APSAL contains substantially broader authoring, protocol, registry, packaging, and Studio functionality. This notice should not be read as claiming those systems are part of GravityPort.

The upstream Apache License 2.0 text is available in APSAL Open's tagged source at <https://github.com/henyjone/apsal-open/blob/v0.14.0/LICENSE>.

## Electron (desktop shell)

The GravityPort desktop app is built on **Electron**, which bundles Chromium and Node.js.

- Project: `electron/electron`
- Version: 43.8.3 (pinned in `package.json`)
- Upstream license: MIT License; the bundled Chromium, Node.js, and their own dependencies keep their respective licenses
- Source: <https://github.com/electron/electron>
- Runtime role: the application window, menus, native integrations, and the embedded Node.js runtime that runs the local GravityPort service.

The license texts are at <https://github.com/electron/electron/blob/main/LICENSE> and, for Chromium and its dependencies, in the `LICENSES.chromium.html` file that every Electron release includes. The copies from the Electron build GravityPort is packaged with ship in the desktop package's `licenses` folder.

## sharp and libvips (image processing)

Thumbnails, previews, and image metadata are produced with **sharp**, which ships prebuilt **libvips** binaries for each platform.

- Projects: `lovell/sharp` and `libvips/libvips`
- Dependency: `sharp` 0.35.x with the platform `@img/sharp-*` and `@img/sharp-libvips-*` packages (libvips 8.18)
- Upstream licenses: sharp is Apache License 2.0; libvips and the prebuilt `@img/sharp-libvips-*` binaries are GNU Lesser General Public License v3.0 or later (LGPL-3.0-or-later)
- Sources: <https://github.com/lovell/sharp> and <https://github.com/libvips/libvips>; the build scripts for the prebuilt binaries are at <https://github.com/lovell/sharp-libvips>
- Runtime role: decoding, resizing, and encoding images locally; images never leave the computer for this.

libvips is used unmodified and is dynamically linked as a separate shared library (`libvips-cpp.*.dylib` under `node_modules/@img/sharp-libvips-darwin-arm64/lib/` on macOS, the libvips `.dll` files under `node_modules/@img/sharp-win32-x64/lib/` on Windows, both in `app.asar.unpacked` inside the app), so it can be replaced with a compatible build under the terms of the LGPL. The LGPL text is at <https://github.com/libvips/libvips/blob/master/LICENSE>, and the libraries bundled into the prebuilt binary, with their licenses, are listed at <https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md>. The same list, with the version of each library that ships, is section 3 of `THIRD_PARTY_LICENSES.txt` in the desktop package's `licenses` folder, next to the LGPL and GPL texts.

## better-sqlite3 and SQLite (library database)

The library database (`mosa.db`) is read and written through **better-sqlite3**, which compiles in **SQLite**.

- Projects: `WiseLibs/better-sqlite3` and SQLite
- Dependency: `better-sqlite3` 13.x
- Upstream licenses: better-sqlite3 is MIT License; SQLite is in the public domain
- Sources: <https://github.com/WiseLibs/better-sqlite3> and <https://sqlite.org/copyright.html>
- Runtime role: the local storage engine for the asset library and its indexes.
