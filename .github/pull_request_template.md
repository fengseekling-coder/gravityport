## What changed

Describe the user-visible behavior and the files or components affected.

## Why

Explain the problem, root cause for a fix, and the intended outcome.

## Privacy and security

Describe any changes to local file access, source roots, browser permissions, network requests, Tokens, Prompt/provenance data, or validation boundaries. Write `No change` when none apply.

## Verification

List the exact checks run and their results.

## Checklist

- [ ] The change is focused and includes regression coverage where behavior changed.
- [ ] Public docs and changelog are updated when contracts changed.
- [ ] User-visible changes have a Chinese and English sentence in `release-notes.json` → `unreleased`.
- [ ] No real Prompts, user media, Tokens, credentials, session logs, local paths, or deployment material are included.
- [ ] Dependency license metadata is unchanged unless the dependency itself changed.
- [ ] `npm test`, `npm run lint`, `npm run check`, and `git diff --check` pass, or exceptions are explained above.
- [ ] If this PR changes how assets enter, are deduplicated, organized, or deleted, ARCHITECTURE.md §8 is updated in the same PR.
