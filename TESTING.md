# Testing smart-doctor

Steps 1–4 need no accounts, no credentials and no internet. Step 5 uses free public sandboxes (synthetic data). Step 6 is your own setup.

## 1. Automated tests (under a minute)

```bash
npm install
npm test          # 143 tests
npm run demo      # 25 broken scenarios and what smart-doctor concludes for each
```

`npm test` covers unit checks, CLI, profiles and the setup wizard, the UI server, and end-to-end runs against the mock EHR for every failure mode — backend services (private key and client secret) and user sign-in (loopback and paste-back, public and confidential clients). Dedicated tests assert that no output or HTTP trace ever contains a token, code, verifier, assertion or private key.

`npm run demo -- --full` prints the full report for every scenario. Read a few: if a diagnosis or its wording looks wrong to you, that's worth fixing before going public.

## 2. The CLI against the practice EHR (5 minutes)

Terminal 1:

```bash
node bin/smart-doctor.js mock --write-profiles
```

Terminal 2, in the same folder:

```bash
node bin/smart-doctor.js check demo-backend                                     # login works
SMART_DOCTOR_DEMO_SECRET=demo-secret-value node bin/smart-doctor.js check demo-secret
node bin/smart-doctor.js check demo-launch          # your browser opens: click Allow → redirect is caught
node bin/smart-doctor.js check demo-launch-paste    # click Allow → browser lands on app.example.com
                                                    # (it won't load — that's the point): copy the address
                                                    # bar and paste it into the terminal
```

Now break things and check the diagnosis:

| Try | Expected top cause |
|---|---|
| `check demo-backend --kid wrong` | kid not in the JWKS |
| `check demo-backend --aud http://127.0.0.1:4013/oauth2/token/` | aud mismatch (trailing slash) |
| `check demo-backend --scope system/Patient.write` | scopes not allowed |
| `SMART_DOCTOR_DEMO_SECRET=nope … check demo-secret` | client secret rejected |
| `check demo-launch --redirect-uri http://localhost:9999/callback` | redirect URI not registered (after ~5 min, or add `--wait 20`) |
| `check demo-launch`, then click **Deny** | access denied |
| `check demo-launch-paste`, paste the URL from an *earlier* attempt | state does not match |
| restart the mock with `--mode clock-skew` → `check demo-backend` | clock skew |
| restart with `--mode secret-only` → `check demo-backend` | server doesn't accept this auth method |
| restart with `--mode no-patient-context` → `check demo-launch` | no patient context (warning) |
| restart with `--mode user-denies`, `wrong-state`, `rate-limit`, … | `mock --list-modes` shows all 18 |
| add `--verbose` to anything | every request and response, secrets masked |
| add `--report` to anything | paste-safe Markdown; client ID masked |

## 3. The guided setup (2 minutes)

With the mock still running, in an empty folder:

```bash
node /path/to/smart-doctor/bin/smart-doctor.js init
```

Choose backend, FHIR URL `http://127.0.0.1:4013/fhir`, client ID `demo-backend`, private key, type **new** for the key… The profile saves, but the run will fail with *kid not in the JWKS* — correct, because the mock doesn't know your new key. That's a realistic first-day experience; the diagnosis should make the fix obvious.

## 4. The web view (5 minutes)

```bash
npm run ui          # opens your browser with the web view + practice EHR
```

- Pick **demo-backend** → **Run check**: the rhythm strip draws one beat per step.
- **New profile** → copy demo-backend with kid `typo` → run: the strip flatlines red at JWKS and the causes explain why.
- **demo-launch** → Run → **Open the sign-in page** → Allow: the strip continues on its own.
- **demo-launch-paste** → Run → Open the sign-in page → Allow → copy the address of the page that fails to load → paste → Continue.
- **Copy report for a ticket** → paste somewhere: client ID masked, no tokens.
- Try it on your phone-sized window and in dark mode.

Optional, automated screenshots of every state (needs Playwright):

```bash
npm i -D playwright && npx playwright install chromium
npm run smoke:ui    # → screenshots/
```

## 5. Public sandboxes (synthetic data only)

**Automated, no account needed (about 10 seconds):**

```bash
npm run smoke:sandbox     # 16 deliberate breakages against launch.smarthealthit.org; exit 1 if a diagnosis differs
npm run smoke:sandbox -- --full    # plus every report
```

It generates throwaway keys and encodes each scenario into a simulated FHIR base URL. With a practitioner and patient preset, the launcher skips login and consent, so the sign-in flow runs end to end without a browser. It also covers backend services (`backend-service` launch type with your public JWKS) and the launcher's simulated errors (`auth_invalid_redirect_uri`, `token_invalid_jti`, …). Some simulated errors don't reach smart-doctor: `request_invalid_token`/`request_expired_token` only set a flag for the launcher's own JS client in the sign-in flow, and `token_invalid_scope` only applies to backend services.

For manual runs use a **fresh key pair** made for testing — never a work key: `node bin/smart-doctor.js keygen --alg ES384 --kid sandbox-1 --out ~/sd-sandbox-keys`.

**SMART Health IT reference servers** (<https://launch.smarthealthit.org> for user sign-in, <https://bulk-data.smarthealthit.org> for backend services) let you register by pasting your public JWKS or picking options, and give you a client ID and FHIR URL. They can also simulate errors on purpose — compare smart-doctor's diagnosis with the error you chose. Their exact options change over time; follow the page.

**Epic** (<https://fhir.epic.com>): create a free account and an app (backend systems, or a patient/clinician-facing app with a redirect URI). Use the **non-production** client ID. Changes can take a while to propagate — run once before it's ready and check that the diagnosis mentions that.

```bash
node bin/smart-doctor.js init      # FHIR URL: https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4
```

**What real vendor servers do differently** (seen on sandboxes, Oct 2026 — useful when reading a diagnosis):

- Several EHRs check the authorization code *before* the client credentials: a wrong secret plus a bad code returns `invalid_grant` (or a vendor variant), not `invalid_client`. A "bad code" answer therefore doesn't prove the secret is right; only a real sign-in does.
- Error codes aren't always standard: `Invalid Grant` / `Invalid Client` (spaces, capitals), `invalid_code`, or `invalid_request` with "Authorization code … is not valid".
- Epic checks the client_id before login (unknown ID → an HTTP 200 "OAuth2 Error" page) but checks the redirect URI only after login; at the token endpoint an unregistered `redirect_uri` comes back as `invalid_client`.
- A server may accept a client auth method it doesn't advertise in `token_endpoint_auth_methods_supported`.
- A SMART configuration can be served from a cache with a stale `Date` header (no `Age`), which looks like clock skew.

## 6. Your own real setup (last)

Run it yourself — don't paste keys or secrets into any chat. Start with `--offline`, then without. If you share results (with a colleague, a vendor, or an AI), share `--report` output only.

## 7. Standalone binary

```bash
npm run build:binaries -- linux-x64     # or darwin-arm64 / darwin-x64 / windows-x64
scripts/binary-smoke.sh dist/smart-doctor-linux-x64
```

Binaries built on Linux for macOS are unsigned; on a Mac run `codesign --force --sign - dist/smart-doctor-darwin-arm64` (the release workflow does this on a macOS runner).

## Ready to share when

- `npm test` is green on macOS and Linux (CI runs Node 18/20/22 on Linux, macOS and Windows).
- The demo's diagnoses all read right to you.
- One real sandbox run succeeded and one deliberately broken sandbox run produced the right top cause, for each flow you care about.
- You'd paste a `--report` from your own setup into a public GitHub issue without hesitation.
