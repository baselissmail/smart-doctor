---
name: smart-doctor
description: Diagnose failing SMART on FHIR logins — backend services (client_credentials with private_key_jwt or client secrets) and user sign-in (SMART App Launch with PKCE) — against Epic, Oracle Health/Cerner, athenahealth, OpenEMR or any SMART server. Use when a token request or EHR sign-in fails (invalid_client, invalid_grant, unauthorized_client, invalid_scope, redirect problems), when someone pastes a token-endpoint error, or wants to check a JWKS or client assertion.
---

# smart-doctor

`smart-doctor` checks every part of a SMART login that can be checked from the client side, runs the real login once, and ranks the likely causes in plain English.

## Safety rules (follow exactly)

1. **Never read, print, `cat`, open or copy a private key file** (`*.pem`, `*.key`, private JWK/JWKS). Pass its *path* (`--key`, or `key:` in a profile).
2. **Never ask for, accept, or put a client secret on a command line.** Secrets come from an environment variable the user sets themselves (`--client-secret-env NAME`, default `SMART_DOCTOR_CLIENT_SECRET`). Never write secrets into `smart-doctor.yaml` (the tool refuses anyway).
3. Never ask the user to paste access tokens, refresh tokens, authorization codes or assertions into the chat. Share `--report` output instead — it masks all of those and the client ID.
4. Only use `inspect` on assertions that have already expired.
5. Do not add `--probe` against clinical resources unless the user asks; even then only the status code is shown.
6. Only run against servers the user is authorised to access.

## Finding the CLI

1. `smart-doctor` on PATH (`npm link` in the repo, or a downloaded binary).
2. Otherwise `node <repo-root>/bin/smart-doctor.js` (run `npm install --omit=dev` once if `node_modules` is missing).

## Workflows

### Start from a profile (preferred)

```bash
smart-doctor profiles                  # what exists
smart-doctor check <profile> --report  # run one
```

No profile yet? Ask the user to run `smart-doctor init` themselves (it's interactive), or build one non-interactively and save it:

```bash
smart-doctor check --fhir <FHIR base> --client-id <id> --key <path> --kid <kid> --jwks-url <url> --save <name>
```

### Backend services login fails

```bash
smart-doctor check <profile> --report --verbose
```

Variations: `--offline` (no token request or sign-in) · `--aud <value>` (reproduce the app's aud) · `--auth client_secret_basic|client_secret_post` · `--vendor epic|oracle-health|openemr|athena` · `--show-public-jwk`.

### User sign-in (SMART App Launch) fails

```bash
smart-doctor launch <profile>      # or: check <profile> when the profile has flow: launch
```

This needs the human: a browser opens for sign-in.
- Redirect URI `http://localhost:PORT/...` or `127.0.0.1` → the tool catches the redirect itself.
- Any other redirect URI → after signing in, the user copies the address they landed on and pastes it into the terminal. Tell them an error page there is expected.
Prefer suggesting `smart-doctor ui` for this flow — it shows a button and a paste box.

### Only an error message

```bash
smart-doctor explain '<error JSON or text>' --url <FHIR base or token URL>
```

### Practice / reproduce without credentials

```bash
smart-doctor mock --write-profiles     # then: check demo-backend | demo-secret | demo-launch | demo-launch-paste
smart-doctor mock --list-modes         # 15 failure modes, e.g. --mode clock-skew
```

## Reading results

Explain the top cause and its fix. If it is "Server-side registration does not match" or "Client secret rejected", walk the user through comparing the vendor-portal registration with the printed client_id, kid, key thumbprint, JWKS URL and redirect URI.

Exit codes: 0 works · 1 problems found · 2 usage error.
