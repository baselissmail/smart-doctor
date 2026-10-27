# Notes for AI coding agents (and humans in a hurry)

smart-doctor diagnoses failing SMART on FHIR logins: backend services (`client_credentials`) and user sign-in (SMART App Launch + PKCE). MIT licensed, plain JavaScript ES modules, Node 22+, no build step.

## Ground rules

- **Never read, print or copy private keys (`*.pem`, `*.key`, `private-key*`), client secrets or tokens.** Pass key files by path; secrets come from environment variables only.
- No real organisation's keys, client IDs, tenant IDs, endpoints or names, and no patient data — in code, tests, docs, commit messages or issues. Use the practice EHR (`src/mock/server.js`) or public sandboxes.
- Vendor hints need a public `source` (see CONTRIBUTING.md).
- Conventional commits. Don't push, tag or publish unless a maintainer asks.

## Orientation

- [ARCHITECTURE.md](ARCHITECTURE.md): the Run event stream, adapters, and why redirects work everywhere.
- Engine: `src/doctor.js` (backend), `src/launch.js` (sign-in), `src/diagnose.js` (ranks causes), `src/core/` (Run events, redaction, results), `src/options.js` (profile + flags + env → options).
- Knowledge (data): `src/knowledge/causes.js`, `src/knowledge/errors.js`, `src/vendors/*.js`. Guarded by `test/knowledge.test.js`.
- Types: JSDoc, checked by `tsc` (no `.ts` files, no build step). Shared shapes in `src/types.js`.
- Front-ends: `src/cli.js`, `src/ui/`, the GitHub Action (`action.yml`). Website generator: `site/`.

## Commands

```bash
npm run check            # lint + type check + format check + tests (no network)
npm run typecheck        # TypeScript over the JSDoc types (src/types.js holds the shared shapes)
npm test                 # tests only
npm run demo             # 25 broken scenarios and their diagnoses
npm run smoke:sandbox    # real-server check against launch.smarthealthit.org (needs internet)
npm run site             # build + serve the website on http://localhost:4400
node bin/smart-doctor.js mock --write-profiles   # practice EHR; then: check demo-backend | demo-launch
```

## Definition of done

`npm run check` passes; new behaviour has a test; new server wording is added to `SEEN_ON_REAL_SERVERS`; user-visible changes are in CHANGELOG.md (Unreleased).
