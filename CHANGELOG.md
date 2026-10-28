# Changelog

## Unreleased

- `--help`, the web view's copy message, the website and the docs now say that `--redact` and shared reports also mask patient and user IDs.
- Documentation counts corrected: 25 demo scenarios (21 broken on purpose), 16 sandbox scenarios (12 deliberate breakages), 18 practice-EHR failure modes, CI on Node 22 and 24.

## 0.2.3 — 2026-10-28

- Fixed: a client secret, code or token that the server echoed back (for example in `error_description`) showed in full in `--verbose` output and in `--json`, including `--json --redact`. The HTTP trace now masks every value the request carried, wherever it appears in the response.
- Fixed: masked client secrets, passwords and PKCE verifiers no longer keep their first 8 characters, and neither do secrets masked inside server text. Tokens and codes keep a short prefix so two values can still be told apart.
- Fixed: `--report` and `--redact` masked the client id but not the patient, encounter and `fhirUser` ids from a sign-in, which appeared in check details, the token response and the probe URL. Your terminal still shows them, so you can confirm who signed in.
- Fixed: with `--redact`, a short client id was also masked inside other words (client id `app` turned `application/json` into `***lication/json`). Only whole values are masked now.
- `--offline` now works for sign-in (launch). It runs every check up to the sign-in and never opens the browser. The CLI previously refused it, and the library API ignored `tokenRequest: false` and signed in anyway. Its description now says that discovery and the JWKS are still read.

## 0.2.2 — 2026-10-28

- **Security hardening** from CodeQL code scanning: trimming trailing slashes from URLs and reading an `Authorization: Basic` header no longer slow down quadratically on crafted input (ReDoS). Markdown reports escape backslashes, so a detail can no longer break out of its table cell. The practice EHR no longer returns internal error messages.
- **Property-based tests (fuzzing)** with fast-check: `explain`, callback parsing, secret masking, error-code normalisation and scope parsing are exercised with thousands of generated inputs on every CI run.
- OpenSSF Best Practices badge (passing).
- `jose` 6.

## 0.2.1 — 2026-10-28

- Release files now include signed build provenance (`provenance-*.sigstore.json`); the Docker image is pinned to a digest.
- **Repository standards**: `main` and release tags protected by rulesets (pull requests, required CI, linear history, signed commits), CodeQL code scanning, OpenSSF Scorecard, every workflow action pinned to a commit, build attestations for release binaries.
- README rewritten for GitHub and npm, with images generated from real runs (`scripts/readme-images.mjs`).

- **Type checking**: TypeScript checks the JSDoc types (`npm run typecheck`, in `npm run check` and CI). Shared option types in `src/types.js`.
- Servers report a busy port as an error instead of crashing (shared `listen` helper).
- Fixed: the `id_token` check now reports an audience mismatch once, and tells an expired token, a missing signing key and an unreadable server JWKS apart from a bad signature.
- Fixed: the setup wizard saved an existing key path relative to the current folder instead of the profile file.
- Fixed: `--timeout 30s` (and `--wait`, `--port`, `--status`) became a NaN timer that looked like a network failure; whole numbers are now required.
- Fixed: a secret passed to `--client-secret-env` (or typed into the wizard's variable-name question) could be printed back, including in `--report`; only variable names are accepted and nothing else is echoed.
- Fixed: server error text that echoed the request's code, secret or a token reached checks and reports unmasked.
- Fixed: the local web view could hang on "Running…" after a dropped connection and replay a run's events twice.
- The local web view now applies the same option fallbacks and validation as the CLI.
- Library: `runLaunch` and `Run` are exported; `UsageError`, results and options live in `src/core/` and `src/options.js`.
- Website: redesigned around a bedside-monitor hero built from a real run, with a diagram of what leaves your machine.
- Practice EHR: new failure modes `id-token-wrong-aud` and `server-jwks-down` (18 in total).

## 0.2.0 — 2026-10-28

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
