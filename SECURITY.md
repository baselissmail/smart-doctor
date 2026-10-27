# Security

## Reporting a vulnerability

**Please don't open a public issue for security problems.** Report them privately:

1. Preferred: GitHub's private vulnerability reporting — [Report a vulnerability](https://github.com/baselissmail/smart-doctor/security/advisories/new).
2. Or email **basel.issmail@gmail.com** with "smart-doctor security" in the subject.

Include what you did, what happened, and the version (`smart-doctor --version`). Never include real keys, secrets, tokens or patient data — a synthetic reproduction against the practice EHR (`smart-doctor mock`) is ideal.

What to expect: smart-doctor is maintained in spare time, but security reports come first. We aim to acknowledge a report within 3 working days and to share an assessment within 10, and we agree a fix or mitigation plan with you before anything is disclosed. Reporters are credited in the release notes unless they prefer otherwise.

| Version | Supported |
|---|---|
| Latest minor release (0.x) | ✔ security fixes |
| Older releases | ✖ please upgrade |

Especially in scope: anything that could leak a private key, client secret, token, authorization code or PKCE verifier into output, logs, files or the network; the local web UI's protections (localhost binding, session token, Host check, CSP); and profile handling.

## What smart-doctor does with your secrets

| Secret | What happens |
|---|---|
| **Private key** | Read from the path you pass, used in-process to sign one test assertion. Never transmitted, written, logged or printed. Only the public key and its SHA-256 JWK thumbprint are ever shown. |
| **Client assertion** (signed JWT) | Sent once to the token endpoint you specify — exactly what your app would send. Never printed (masked in every output). Lifetime ≤ 5 minutes; single-use via a random `jti`. |
| **Access token** | Kept in memory only for the optional probe; masked in every output; never written to disk. |
| **Client secret** | Read only from an environment variable (never from command-line flags, which shell history and `ps` capture) or typed into the local UI's password field for a single run. Sent only to the token endpoint. Never written, logged or printed; masked in the HTTP trace. |
| **Authorization code, PKCE verifier, refresh/id tokens** | Kept in memory for the run; masked in every trace and report. |
| **Profiles (`smart-doctor.yaml`)** | Hold *references* only: a key path and an environment-variable name. Saving a profile that contains a secret-looking field is refused. Safe to commit. |
| **client_id** | Not a secret, but masked by `--report` and `--redact`. |
| **Server responses** | Discovery documents and token-endpoint errors are shown. The optional `--probe` shows the HTTP status and content type only — never a response body. |

## The local web UI (`smart-doctor ui`)

It can read key files from disk, so it is locked down:

- binds `127.0.0.1` only;
- every API call needs a random per-session token from the URL printed at start-up;
- requests whose `Host` header is not `127.0.0.1:<port>` / `localhost:<port>` are refused (DNS-rebinding defence);
- strict Content-Security-Policy (`default-src 'none'`), no inline script, no third-party requests (fonts are served locally);
- secrets typed into the page are used for that one run and kept only in memory.

smart-doctor sends no telemetry and makes no network requests other than to the URLs you pass (FHIR base, token URL, JWKS URL).

## Using it with AI agents

The bundled skill instructs agents to pass key files **by path only** and never to read, print or copy them. You can enforce this in Claude Code by denying reads of key files in your settings, for example:

```json
{ "permissions": { "deny": ["Read(**/*.pem)", "Read(**/*.key)", "Read(**/private-key*)"] } }
```

## Recommendations

- Use separate keys for sandbox, non-production and production.
- Never commit keys. This repo's `.gitignore` excludes `*.pem`, `*.key` and `private*.json`.
- If `smart-doctor` reports **"JWKS contains private key material"**, treat the key as compromised: remove it, rotate, and re-register.
