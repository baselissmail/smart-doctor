<p align="center">
  <a href="https://baselissmail.github.io/smart-doctor/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/baselissmail/smart-doctor/main/docs/images/banner-dark.png">
      <img src="https://raw.githubusercontent.com/baselissmail/smart-doctor/main/docs/images/banner-light.png" width="880" alt="smart-doctor shows a SMART on FHIR login as a heartbeat: discovery, clock and the client assertion pass, the token request flatlines with invalid_client, and the most likely cause is named: your kid is not in the JWKS the server knows about.">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/smart-doctor"><img alt="npm version" src="https://img.shields.io/npm/v/smart-doctor?color=0b7a6b&label=npm"></a>
  <a href="https://github.com/baselissmail/smart-doctor/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/baselissmail/smart-doctor/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/baselissmail/smart-doctor"><img alt="OpenSSF Scorecard" src="https://api.scorecard.dev/projects/github.com/baselissmail/smart-doctor/badge"></a>
  <a href="https://www.npmjs.com/package/smart-doctor"><img alt="Node.js 22 or newer" src="https://img.shields.io/node/v/smart-doctor?color=0b7a6b"></a>
  <a href="https://github.com/baselissmail/smart-doctor/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-0b7a6b"></a>
</p>

<p align="center">
  <strong>Find out why a SMART on FHIR login fails</strong>, for backend services or user sign-in,<br>
  in seconds, with your keys and secrets never leaving your machine.
</p>

<p align="center">
  <a href="https://baselissmail.github.io/smart-doctor/">Website</a> ·
  <a href="https://baselissmail.github.io/smart-doctor/errors/">Error catalogue</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="https://github.com/baselissmail/smart-doctor/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

---

EHR token endpoints answer almost every client problem with the same thing:

```json
{ "error": "invalid_client" }
```

That's deliberate: servers shouldn't tell attackers what went wrong. So you're left guessing. Is `aud` wrong? Is the `kid` not published, or the JWKS unreachable? Is your clock off? Is the client ID from the wrong environment, or the redirect URI not registered *exactly*? Was the authorization code already used?

**smart-doctor checks everything that can be checked from your side, runs the real login once, and ranks the likely causes in plain English**, with the evidence and the exact next step.

<p align="center">
  <img src="https://raw.githubusercontent.com/baselissmail/smart-doctor/main/docs/images/terminal.png" width="760" alt="Terminal output of smart-doctor check: key, discovery and clock pass; the JWKS check finds that kid typo-kid is not published; the token request fails with HTTP 401 invalid_client; the most likely cause is that the kid is not in the JWKS the server knows about, with the fix.">
</p>

## Quick start

```bash
npx smart-doctor ui --demo          # practise first: a web view with a practice EHR that fails on purpose
npx smart-doctor init               # your server: a few questions, everything else is discovered
npx smart-doctor check my-profile   # run it any time
```

Needs Node.js 22 or newer. No Node? Use a [standalone binary](https://github.com/baselissmail/smart-doctor/releases) for macOS, Linux or Windows.

## What it checks

| Flow | Client authentication | What it checks |
|---|---|---|
| **Backend services**<br>`client_credentials` | `private_key_jwt`, `client_secret_basic`, `client_secret_post` | key or secret · discovery · clock · JWKS (reachable, your `kid`, **the published key is yours**, **no private-key leaks**) · assertion (`aud`, `exp` ≤ 5 min, `jti`, `kid`, `iss`/`sub`) · the real token request · granted scopes · optional FHIR call (status only) |
| **User sign-in**<br>SMART App Launch, `authorization_code` + PKCE | public (PKCE only), client secret, private key | discovery (authorize endpoint, S256, capabilities) · **your redirect URI** · sign-in · `state` and `iss` · code exchange · patient context · `id_token` signature, `aud`, `fhirUser` · refresh token · optional FHIR call (status only) |

When the server still refuses after every local check passes, smart-doctor reads the server's own words, adds vendor hints (Epic, Oracle Health, athenahealth, OpenEMR) and names the server-side causes it cannot see, so you know exactly what to ask your EHR contact. Every cause is explained in the [error catalogue](https://baselissmail.github.io/smart-doctor/errors/).

## The same, in your browser

<p align="center">
  <img src="https://raw.githubusercontent.com/baselissmail/smart-doctor/main/docs/images/web-view.png" width="880" alt="The local web view after a failing run: a heartbeat trace beats for key, discovery and clock, then turns red and flatlines at JWKS; the verdict reads 'The login breaks at JWKS', with the most likely cause, its evidence and the fix, next to a table of every check.">
</p>

`smart-doctor ui` opens a local web view: pick a profile, run it, watch the trace, and copy a ticket-ready report. It binds to `127.0.0.1` only, needs a per-session token and makes no third-party requests.

## Highlights

- **Ranked causes, not just errors.** Local checks first, then the server's own wording (including non-standard spellings like `Invalid Grant`), then vendor knowledge, each with evidence and a fix.
- **Works with the redirect URI your company already registered.** `http://localhost:PORT` redirects are caught directly; for anything else you sign in, land on your company's page and paste its address back. No registration changes.
- **Safe to share.** `--report` writes Markdown for a ticket, a vendor or an AI chat, with the client ID, tokens, codes and secrets masked.
- **Practice before production.** A built-in practice EHR with 18 failure modes, and profiles in a git-friendly `smart-doctor.yaml` that refuses to hold secrets.
- **Built for CI.** A GitHub Action runs your profile every night and catches expiring keys and registration drift before production does.
- **Checked against real servers.** 16 deliberate breakages against the public SMART launcher give the right diagnosis (`npm run smoke:sandbox`).

## Install

| You have | Do |
|---|---|
| Node.js 22+ | `npx smart-doctor …`, or `npm install --global smart-doctor` |
| No Node.js | Download the binary for your OS from [Releases](https://github.com/baselissmail/smart-doctor/releases), with checksums and [build attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations) (`gh attestation verify <file> --repo baselissmail/smart-doctor`) |
| Docker | `docker build -t smart-doctor https://github.com/baselissmail/smart-doctor.git && docker run --rm -v "$PWD:/work" smart-doctor check my-profile` |
| GitHub Actions | [Nightly monitoring](#nightly-monitoring) |
| Claude Code | `/plugin marketplace add baselissmail/smart-doctor`, then `/plugin install smart-doctor@smart-doctor`. The skill passes keys by path only and shares `--report` output |

## Profiles

Profiles live in `smart-doctor.yaml` (the nearest one up from the current folder, or `~/.config/smart-doctor/`). **They never contain secrets**: keys are referenced by path and secrets by environment-variable name, so you can commit them and share them with your team. Writing a secret into a profile is refused.

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

<details>
<summary><strong>All commands and flags</strong></summary>

| Command | Does |
|---|---|
| `smart-doctor` | First time: guided setup. After that: pick a profile to run |
| `init` | Guided setup → saves a profile |
| `check [profile]` | Diagnose (flow from the profile, or `--flow backend\|launch`) |
| `launch [profile]` | `check --flow launch` |
| `ui` | Local web view (`--demo` adds the practice EHR) |
| `profiles` | List profiles |
| `explain '<error>'` | Explain an error message you already have |
| `inspect <jwt>` | Lint a client assertion from your app's logs (no key needed; the signature is never printed) |
| `keygen` | New RS384/ES384 key pair and public JWKS |
| `mock` | Practice EHR with 18 failure modes (`--list-modes`) |

Useful flags: `--verbose` (every HTTP request and response, secrets masked) · `--report` (paste-safe Markdown) · `--json` · `--offline` (local checks only) · `--aud` (reproduce your app's `aud`) · `--redirect-mode paste|loopback`. Run `smart-doctor --help` for everything.

Exit codes: `0` works · `1` problems found · `2` usage error.

</details>

## Nightly monitoring

```yaml
# .github/workflows/smart-login.yml
on: { schedule: [{ cron: '17 5 * * *' }] }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5         # contains smart-doctor.yaml and the key path
      - uses: baselissmail/smart-doctor@v0
        with: { profile: epic-prod-backend }
        env: { OUR_APP_SECRET: '${{ secrets.OUR_APP_SECRET }}' }
```

The report lands in the job summary; the job fails when the login does.

## Safety model

- Your private key signs one test assertion in-process. It is never sent, written, logged or printed. Secrets come only from environment variables, or a password field in the local web view kept in memory for one run.
- What goes to the EHR is exactly what your app sends anyway.
- Every HTTP exchange is redacted **inside the engine** before any front-end sees it: assertions, secrets, authorization codes, PKCE verifiers and access, refresh and id tokens. Server error text is masked too. Tests enforce all of it.
- The FHIR call records the status code only, never a response body, so no patient data can reach a report.
- No telemetry, no account, no cloud.

Details: [SECURITY.md](https://github.com/baselissmail/smart-doctor/blob/main/SECURITY.md) · how it's built: [ARCHITECTURE.md](https://github.com/baselissmail/smart-doctor/blob/main/ARCHITECTURE.md) · how it's tested: [TESTING.md](https://github.com/baselissmail/smart-doctor/blob/main/TESTING.md).

## Limitations

- It cannot see the server's registration. When every local check passes and the server still refuses, it ranks the remaining server-side causes; it can't prove which one.
- Vendor hints come from public documentation and community reports; every installation is configured differently.
- Not covered yet: EHR launch (launching from inside the EHR), mutual TLS, DPoP. See the [roadmap](https://github.com/baselissmail/smart-doctor/blob/main/ROADMAP.md).
- A diagnostic aid, not certification: use [Inferno](https://inferno.healthit.gov/) for conformance.

## Contributing

Every login failure someone figured out the hard way is worth teaching smart-doctor, and most contributions are a few lines of data plus a test: a server's error message, a vendor quirk with a public source, a clearer fix. Start with [CONTRIBUTING.md](https://github.com/baselissmail/smart-doctor/blob/main/CONTRIBUTING.md); the [roadmap](https://github.com/baselissmail/smart-doctor/blob/main/ROADMAP.md) lists bigger pieces marked *help wanted*.

- Questions and ideas: [Discussions](https://github.com/baselissmail/smart-doctor/discussions) · getting help: [SUPPORT.md](https://github.com/baselissmail/smart-doctor/blob/main/SUPPORT.md)
- Wrong diagnosis? [Tell us](https://github.com/baselissmail/smart-doctor/issues/new/choose) with your `--report` output.
- Security problems: privately, as described in [SECURITY.md](https://github.com/baselissmail/smart-doctor/blob/main/SECURITY.md).
- Everyone taking part follows the [Code of Conduct](https://github.com/baselissmail/smart-doctor/blob/main/CODE_OF_CONDUCT.md).

## License

[MIT](https://github.com/baselissmail/smart-doctor/blob/main/LICENSE) © Basel Issmail. Not affiliated with HL7, SMART Health IT or any EHR vendor; vendor names are trademarks of their owners.
