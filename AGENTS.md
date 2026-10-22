# GravityPort Contributor Instructions

## Repository Boundary

- Keep source code, tests, public documentation, and reproducible configuration in this repository.
- Do not commit user libraries, generated media, prompts, metadata exports, session logs, canvas data, deployment snapshots, screenshots, or local paths. Product screenshots endorsed by the maintainer and stored under `docs/images/` are the one exception; every other screenshot stays out.
- Keep third-party plugin code outside this repository. Integrations must use configured paths rather than hard-coded machine-specific locations.
- Keep one-off implementation summaries, delivery reports, restart instructions, and manual test checklists out of the repository root. Fold durable user guidance into the relevant document under `docs/`; leave transient work records outside the checkout.

## Local Development

- Use `npm ci`, `npm test`, `npm run lint`, and `npm run check` before proposing a change.
- Interface changes under `web/gravityport` follow `DESIGN.md`: use the existing `--ui-*`, `--space-*`, and `--radius-*` variables, and update `DESIGN.md` in the same change when a token or component rule changes.
- Start the local service with `npm start`. Configure non-default locations through the documented environment variables.
- The Cowart integration is optional. When it is unavailable, preserve normal library behavior rather than creating plugin-specific files in the checkout.

## Licensing

- GravityPort is source-available under the root `LICENSE` using `PolyForm-Noncommercial-1.0.0`; do not describe it as OSI-approved open-source software.
- Preserve the root `LICENSE`, its `Required Notice`, the README license summary, `COMMERCIAL-LICENSE.md`, and the root package license metadata when changing public files.
- Do not grant, imply, or document commercial-use permission without the copyright holder's separate written authorization.
- Keep third-party dependency licenses unchanged; project licensing metadata and dependency licensing metadata are separate scopes.

## Safety

- Keep all public documentation portable: use relative paths, `$HOME`, or explicit placeholders instead of personal absolute paths.
- Treat imported assets and their Prompt/provenance records as private user data by default.
- Do not widen filesystem allowlists, session roots, or canvas targets merely to make an import succeed.
- Keep browser-extension credentials in local storage, require an explicit ingest Token, and document every captured field and host permission in `PRIVACY.md`.
