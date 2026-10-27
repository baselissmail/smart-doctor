# smart-doctor

[![CI](https://github.com/baselissmail/smart-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/baselissmail/smart-doctor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/smart-doctor)](https://www.npmjs.com/package/smart-doctor)
[![License: MIT](https://img.shields.io/badge/license-MIT-0b7a6b)](LICENSE)

**Find out why a SMART on FHIR login fails — backend services or user sign-in — in seconds, without your keys or secrets ever leaving your machine.**

EHR token endpoints answer almost every client problem with the same thing:

```json
{ "error": "invalid_client" }
```

That's deliberate (servers shouldn't tell attackers what went wrong), so you're left guessing: wrong `aud`? `kid` not published? JWKS unreachable? clock skew? client ID from the wrong environment? redirect URI not registered *exactly*? authorization code already used?

`smart-doctor` checks everything that can be checked from your side, runs the real login once, and ranks the likely causes in plain English — in the terminal, or in a local web view.

**Website and error catalogue:** <https://baselissmail.github.io/smart-doctor/> — every cause it can report, what it means and how to fix it.

```
Most likely causes
  1. aud does not exactly match the token endpoint (very likely)
     The assertion's aud must be the token endpoint URL, character for character…
     evidence: aud "https://ehr.example.org/oauth2/token/" ≠ token endpoint … — trailing slash differs.
     fix: Set aud to the exact token_endpoint string from the SMART configuration.
```

## Two minutes, no accounts: try it against the practice EHR

```bash
npx smart-doctor ui --demo                  # the web view + a practice EHR that fails on purpose
```

Or in the terminal:

```bash
npx smart-doctor mock --write-profiles      # terminal 1: a practice EHR + demo profiles
npx smart-doctor check demo-backend         # terminal 2
npx smart-doctor check demo-launch          # a real sign-in flow in your browser
```

## Your own server

```bash
npx smart-doctor init                # asks ~6 questions, discovers the rest, saves a profile
npx smart-doctor check my-profile
```

Install it globally with `npm install -g smart-doctor` to type `smart-doctor` directly, or download a standalone binary (no Node needed) — see [Install](#install).

## What it covers

| Flow | Client authentication | What it checks |
|---|---|---|
| **Backend services** (system-to-system, `client_credentials`) | `private_key_jwt`, `client_secret_basic`, `client_secret_post` | key/secret · discovery · clock · JWKS (reachable, kid, **published key = your key**, **private-key leaks**) · assertion (aud, exp ≤ 5 min, jti, kid, iss/sub) · token · granted scopes · optional status-only FHIR probe |
| **User sign-in** (SMART App Launch, standalone, `authorization_code` + PKCE) | public (PKCE only), client secret, private key | discovery (authorize endpoint, S256, capabilities) · **redirect URI** · sign-in · `state` and `iss` · code exchange · patient context · `id_token` signature, `aud`, `fhirUser` · refresh token · status-only FHIR probe |

Vendor quirk profiles add hints for **Epic, Oracle Health (Cerner), OpenEMR and athenahealth**.

### Redirect URIs your company already registered

You don't have to change any registration to test a user sign-in:

- **`http://localhost:PORT/…` or `http://127.0.0.1:PORT/…`** → smart-doctor listens on exactly that address and catches the redirect itself.
- **Anything else** (`https://app.yourcompany.com/smart/callback`) → you sign in, your browser lands on that page (even an error page is fine), you paste the address back. smart-doctor validates `state`, exchanges the code with PKCE and carries on.

If the company page is a live app that exchanges the code itself, smart-doctor tells you the code was already used and why.

## Profiles

Profiles live in `smart-doctor.yaml` (nearest one up from the current folder, or `~/.config/smart-doctor/`). **They never contain secrets** — keys by path, secrets by environment-variable name — so you can commit them and share with your team. Writing a secret into a profile is refused.

```yaml
profiles:
  epic-sandbox:
    flow: backend
    fhir: https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4
    clientId: 1234-non-prod
    auth: private_key_jwt
    key: ./keys/private-key.pem      # relative to this file
    kid: sandbox-1
    scope: system/Patient.rs
  our-app-login:
    flow: launch
    fhir: https://fhir.example.org/r4
    clientId: our-app
    auth: client_secret_basic
    secretEnv: OUR_APP_SECRET        # the variable NAME, never the secret
    redirectUri: https://app.example.com/smart/callback
```

Any flag overrides the profile: `smart-doctor check epic-sandbox --kid new-key-2 --verbose`. Save a one-off command as a profile with `--save <name>`.

## Commands

| Command | Does |
|---|---|
| `smart-doctor` | First time: guided setup. After that: pick a profile to run |
| `init` | Guided setup → saves a profile |
| `check [profile]` | Diagnose (flow from the profile, or `--flow backend\|launch`) |
| `launch [profile]` | `check --flow launch` |
| `ui` | Local web view (`--demo` adds the practice EHR) |
| `profiles` | List profiles |
| `explain '<error>'` | Explain an error message you already have |
| `inspect <jwt>` | Lint a client assertion from your app's logs (no key needed; signature never printed) |
| `keygen` | New RS384/ES384 key pair + public JWKS |
| `mock` | Practice EHR with 16 failure modes (`--list-modes`) |

Useful flags: `--verbose` (every HTTP request and response, secrets masked) · `--report` (Markdown safe to paste into a ticket or AI chat) · `--json` · `--offline` (local checks only) · `--aud` (reproduce your app's aud) · `--redirect-mode paste|loopback`. Run `smart-doctor --help` for all.

Exit codes: `0` works · `1` problems found · `2` usage error.

## Install

| You have | Do |
|---|---|
| Node.js 22+ | `npx smart-doctor …`, or `npm install -g smart-doctor` |
| No Node.js | Download the binary for your OS from [Releases](https://github.com/baselissmail/smart-doctor/releases) (checksums included), or build it: `npm run build:binaries` → `dist/` |
| Docker | `docker build -t smart-doctor . && docker run --rm -v "$PWD:/work" smart-doctor check my-profile` |
| CI / monitoring | The GitHub Action: see below |

### Nightly monitoring (catch expiring keys before production does)

```yaml
# .github/workflows/smart-login.yml
on: { schedule: [{ cron: '17 5 * * *' }] }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # contains smart-doctor.yaml and the key path
      - uses: baselissmail/smart-doctor@v0
        with: { profile: epic-prod-backend }
        env: { OUR_APP_SECRET: '${{ secrets.OUR_APP_SECRET }}' }
```

The report lands in the job summary; the job fails when the login does.

## Use it from Claude Code (or another AI agent)

This repo is a Claude Code plugin with a `smart-doctor` skill: `/plugin marketplace add baselissmail/smart-doctor` then `/plugin install smart-doctor@smart-doctor`. The skill tells the agent to pass keys **by path only**, never read or print them, and to share `--report` output.

## Safety model

- Keys are used in-process to sign one test assertion — never sent, logged or printed. Secrets come only from environment variables (or a password field in the local UI, kept in memory for one run).
- What goes to the EHR is exactly what your app sends anyway.
- Every HTTP exchange is redacted **inside the engine** before any front-end sees it: assertions, secrets, authorization codes, PKCE verifiers, access/refresh/id tokens. Tests enforce this.
- The FHIR probe records the status code only — never a response body — so no patient data can reach a report.
- The local UI binds 127.0.0.1 only, requires a per-session token, rejects foreign `Host` headers, sets a strict CSP and makes no third-party requests (fonts are bundled).
- No telemetry.

Details: [SECURITY.md](SECURITY.md). How it's built: [ARCHITECTURE.md](ARCHITECTURE.md). How to test it: [TESTING.md](TESTING.md).

## Limitations

- It cannot see the server's registration. When every local check passes and the server still refuses, it ranks the remaining server-side causes; it can't prove which one.
- Vendor profiles are hints from public documentation and community reports — every installation is configured differently.
- Not covered yet: EHR launch from inside the EHR (only standalone launch), SMART on FHIR v1-only quirks beyond scope syntax, mutual TLS, DPoP.
- A diagnostic aid, not certification — use [Inferno](https://inferno.healthit.gov/) for conformance.

## Contributing

Every login failure someone figured out the hard way is worth teaching smart-doctor, and most contributions are a few lines of data plus a test: a server's error message, a vendor quirk with a public source, a clearer fix. Start with [CONTRIBUTING.md](CONTRIBUTING.md); the [roadmap](ROADMAP.md) lists bigger pieces marked *help wanted*.

- Questions and ideas: [Discussions](https://github.com/baselissmail/smart-doctor/discussions) · getting help: [SUPPORT.md](SUPPORT.md)
- Wrong diagnosis? [Tell us](https://github.com/baselissmail/smart-doctor/issues/new/choose) with your `--report` output.
- Security problems: privately, as described in [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT © Basel Issmail. Not affiliated with HL7, SMART Health IT or any EHR vendor; vendor names are trademarks of their owners.
