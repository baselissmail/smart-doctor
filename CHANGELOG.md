# Changelog

## 0.2.0 — unreleased

First public release.

- **Open source**: Code of Conduct, contributing guide with a "where to add what" map, security policy with private reporting, support guide, issue forms (wrong diagnosis, bug, vendor quirk, feature), PR template, roadmap, Dependabot, CI on Linux/macOS/Windows with Node 22 and 24, release workflow publishing to npm with provenance.
- **Website** (GitHub Pages): landing page and an error catalogue with a page per cause, generated from the knowledge files.
- **Knowledge as data**: causes (`src/knowledge/causes.js`), error wording (`src/knowledge/errors.js`), real-server examples (`src/knowledge/seen.js`) and one file per vendor (`src/vendors/`), each guarded by tests; every vendor hint cites a public source.
- **Linting and formatting** with ESLint and Prettier (`npm run check`).
- Requires Node.js 22 or newer (18 and 20 are end-of-life). `yaml` updated to 2.9.1 (GHSA-48c2-rrv3-qjmp).
- Fixed: the GitHub Action's `action.yml` was not valid YAML.

- **User sign-in (SMART App Launch, standalone)**: authorization code + PKCE (S256), `state` and `iss` validation, patient context, `id_token` signature/aud/fhirUser, refresh tokens, status-only FHIR probe.
- **Works with any company-registered redirect URI**: loopback listener for `localhost`/`127.0.0.1`, paste-back for everything else — no registration changes.
- **Client secrets** (`client_secret_basic`, `client_secret_post`) for both flows, read from environment variables only; public clients for launch.
- **Profiles** in a git-friendly `smart-doctor.yaml` that refuses secrets; `check <name>`, `--save`.
- **Guided setup** (`smart-doctor init`) that discovers the server and saves a profile.
- **Local web UI** (`smart-doctor ui`): rhythm-strip trace of the login, lab-report results, ranked causes, paste-back sign-in, copy-for-ticket report. Localhost-only, token-protected, strict CSP, fonts bundled.
- **`--verbose` HTTP trace**, redacted at the source (assertions, secrets, codes, verifiers, tokens).
- **Event-driven engine** (`Run`) shared by CLI, UI, CI and tests.
- **Practice EHR**: sign-in page, three demo apps, `--write-profiles`, 16 failure modes.
- **Standalone binaries** for macOS, Linux and Windows; Dockerfile; GitHub Action for nightly monitoring; release workflow.
- 143 tests; demo covers 25 failure scenarios.
- **Checked against real servers** (`npm run smoke:sandbox`: 16 deliberate breakages on the public SMART launcher, plus token-endpoint responses from six vendor sandboxes). Fixes from that:
  - Non-standard error codes (`Invalid Grant`, `invalid_code`) are understood instead of producing no causes; a failed request always gets at least one cause.
  - `invalid_request` about the authorization code is reported as a code problem; "Basic authentication is required" as the auth method the server wants, not a wrong secret.
  - "None of the keys in the JWKS have kid/alg …" no longer suggests the JWKS can't be fetched.
  - Sign-in errors use the server's description (client_id, redirect URI, aud); refresh tokens that are issued but rejected get their own cause.
  - No false clock skew when the SMART configuration comes from a cache (stale `Date` header): `Age` is honoured and the token response re-checks the clock.
  - An auth method the server doesn't advertise is a warning, not a failure (some servers accept it anyway).
  - Vendor hints can target one flow or auth method (no JWKS hints for client-secret apps).

## 0.1.0

- `check` for backend services with `private_key_jwt`; `inspect`, `explain`, `keygen`, `mock`; vendor profiles; human/JSON/Markdown output; Claude Code plugin + skill.
