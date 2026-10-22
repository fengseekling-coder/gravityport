# Security Policy

GravityPort reads local creative assets, Prompt and provenance records, and selected local tool-session data. Security reports are handled privately.

## Supported Versions

| Version | Security updates |
| --- | --- |
| `main` and the newest published desktop build (see the [download page](https://gravityport.azhuilab.com/#download)) | Supported |
| Older builds and tagged snapshots | No planned updates |

`v0.1.0` is the final MIT-licensed source snapshot. Later releases use the license in the root `LICENSE`.

## Report a Vulnerability

Do not open a public Issue for a suspected vulnerability.

Use one of these private channels:

1. [GitHub private vulnerability reporting](https://github.com/fengseekling-coder/gravityport/security/advisories/new)
2. Email [fengseekling@gmail.com](mailto:fengseekling@gmail.com) with the subject `[GravityPort Security]`

Include the affected version or commit, impact, reproduction steps, and a minimal proof of concept. Remove real Prompts, user assets, Tokens, cookies, credentials, local absolute paths, and other private data before sending.

The maintainer will acknowledge the report, assess its scope, and coordinate disclosure and a fix when applicable. Do not publish technical details before a fix or agreed disclosure date.

## Security Boundaries

- GravityPort is designed for loopback use on `127.0.0.1`. Public ports, reverse proxies, shared-host deployment, and untrusted multi-user access are unsupported.
- A standalone runtime started with `npm start` keeps Web Capture disabled unless `GRAVITYPORT_WEB_CAPTURE_TOKEN` and an approved extension origin are explicitly configured. Packaged Desktop generates and stores its own random local Token and authorizes only the fixed GravityPort extension origins used by the desktop pairing flow. Treat every Web Capture Token as a local secret.
- Browser-extension origins, input envelopes, declared MIME types, decoded image bytes, file sizes, and pixel counts must be validated before ingest.
- Codex, Grok, and Cowart source roots are explicit allowlists. Do not widen them to work around an import failure.
- Imported media, Prompt text, provenance, page URLs, and session identifiers are private user data by default.

See [PRIVACY.md](PRIVACY.md) and [docs/operations.md](docs/operations.md) for the data and deployment boundaries.

## Out of Scope

- Vulnerabilities in Codex, Chrome, ChatGPT, Grok, Cowart, tldraw, Node.js, or operating-system components should be reported to their respective maintainers.
- Findings that require exposing GravityPort to a public interface, disabling documented validation, or granting an attacker local filesystem access are outside the supported deployment model, though defense-in-depth reports are still welcome.
- This project does not currently operate a paid bug-bounty program.
