# Contributing to GravityPort

GravityPort welcomes focused bug fixes, tests, documentation improvements, and narrowly scoped feature proposals.

GravityPort is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE), not an OSI-approved open-source project. By submitting a contribution, you confirm that you have the right to provide it and agree that it may be distributed under the repository license. A contribution does not grant commercial-use rights.

## Before You Start

- Read [README.md](README.md), [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Use a GitHub Discussion for an early design question or feature proposal.
- Use an Issue for a reproducible bug.
- Report vulnerabilities privately according to `SECURITY.md`.

Do not post real Prompts, user assets, Tokens, cookies, credentials, local absolute paths, session records, or private screenshots.

## Local Setup

Source development requires Node.js 22 or newer and npm. Desktop-specific work is currently validated on macOS arm64 and Windows 10/11 x64. On Windows, use the repository-pinned Node 22.x from `.nvmrc` / `.node-version` before the initial `npm ci`; this matches the clean Windows CI environment and avoids the Electron native-toolchain resolution differences seen with Node 24.

```bash
npm ci
npm test
npm start
```

The default service is local-only at `http://127.0.0.1:43517`. Use sample data or a separate test library. Never point development tests at another user's library or a production library.

## Change Guidelines

- Keep changes focused and preserve existing public APIs unless the change explicitly documents a migration.
- Add regression tests for behavior changes and bug fixes.
- Preserve filesystem, source-root, canvas-target, Token, origin, MIME, and request-size boundaries.
- Keep public documentation portable and free of maintainer-specific paths or operational secrets.
- Update README.md and README.zh-CN.md, the Chinese guide, operations guide, privacy/security policies, and changelog when their contracts change.
- Keep dependency licenses unchanged. Project license metadata belongs only to the root package entry and project files.

## Verification

Run the checks relevant to the change:

```bash
npm test
npm run test:performance
npm run lint
npm run check
npm run audit
git diff --check
```

The performance test is opt-in and may take longer than the regular suite.

`npm run check` combines the JavaScript syntax/source checks with a dead-code scan covering unreferenced modules, exported symbols with no consumer, and CSS classes that no tracked markup or script emits. Remove dead code instead of suppressing the check; justified exceptions live in the exception sets at the top of `scripts/check-dead-code.mjs`.

Continuous integration runs the shared lint/check/test/audit suite on Linux, a packaged desktop/E2E lane on macOS arm64, and a Windows x64 lane covering desktop packaging, platform/path contracts, Electron E2E, and packaged smoke. Platform-specific changes must keep shared behavior in common modules and add platform-focused tests only at the OS boundary.

## Pull Requests

- Create a topic branch from the current `main`.
- Keep commits and the PR description specific to one coherent change.
- Explain the user impact, root cause for fixes, privacy/security implications, and verification performed.
- Link related Issues or Discussions.
- Do not include generated media, private test fixtures, user libraries, session logs, deployment snapshots, or local handoff files.

Pull requests are reviewed against product scope, regression risk, privacy boundaries, test coverage, and license compatibility.
