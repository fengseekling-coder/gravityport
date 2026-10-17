# GravityPort Git Hooks

Version-controlled git hooks. Hooks in this directory are tracked so they survive
clones and can be reviewed, unlike `.git/hooks/` which is local-only.

## Install

```sh
git config core.hooksPath scripts/hooks
chmod +x scripts/hooks/pre-push
```

Or symlink a single hook:

```sh
ln -sf ../../scripts/hooks/pre-push .git/hooks/pre-push
```

## pre-push

Blocks pushes that contain Chrome Web Store extension packages
(`out/store/*`, `*.Chrome-Web-Store.zip`). These are build artifacts produced by
`npm run pack:web-capture-store` and must never enter the source repository,
even if `.gitignore` is bypassed with `git add -f`.
