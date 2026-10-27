# Architecture

smart-doctor borrows four ideas from tools that have earned their reputations.

| Idea | Borrowed from | How it shows up here |
|---|---|---|
| **Gather → judge → report** | Lighthouse | Steps gather facts (HTTP, keys); small pure checks judge them; `diagnose()` ranks causes; renderers only render. |
| **Ports and adapters** | Hexagonal architecture | The engine never knows whether it is driven by the CLI, the web UI, CI or a test. Browser, prompt and output are swappable adapters. |
| **Knowledge as data** | ESLint rules, WireMock/Mockoon scenarios | Cause texts (`src/knowledge/causes.js`), error wording (`src/knowledge/errors.js`), vendor quirks (`src/vendors/*.js`) and mock failure modes (`src/mock/server.js`) are data you can extend without touching the engine. `test/knowledge.test.js` guards their shape, and the website's error catalogue is generated from them. |
| **Local-first, files in git, no account** | Bruno | Profiles are a plain YAML file that refuses secrets. No telemetry, no cloud, fonts bundled. |

## Layout

```
bin/smart-doctor.js        entry point (CLI adapter)
src/
  core/run.js              Run: the event stream every front-end subscribes to
  core/redact.js           masking applied to every HTTP exchange at the source (and to server error text)
  core/result.js           the shared end of every flow: diagnose, emit 'done', shape the result
  core/errors.js           UsageError (bad input: front-ends show the message and exit 2)
  types.js                 shared JSDoc types (RunOptions, RunContext, adapters); checked by `npm run typecheck`
  options.js               profile + flags + environment → RunOptions, validated (used by the CLI and the UI)
  util.js                  check records + the one HTTP helper (records into the Run)
  doctor.js                backend-services flow (client_credentials)
  launch.js                SMART App Launch flow (authorization_code + PKCE)
  keys.js discovery.js clock.js jwks.js assertion.js token.js clientauth.js loopback.js
                           gatherers + checks, one concern each
  diagnose.js              facts → ranked causes (the rules: when each cause applies, how likely)
  knowledge/causes.js      the cause catalogue: title, why, fix (data)
  knowledge/errors.js      non-standard error codes and server wording → causes (data)
  vendors/                 one file per vendor quirk profile + index.js registry (data)
  report.js                human / JSON / Markdown renderers
  profiles.js wizard.js    smart-doctor.yaml + guided setup
  adapters/                browser (system / scripted), prompt (terminal / scripted)
  cli.js                   CLI adapter
  ui/server.js ui/assets.js  local web UI adapter (SSE + a single static page)
  mock/server.js           practice EHR with failure modes
  mock/demo.js             the practice EHR's three demo apps and matching profiles
site/                      static website generator (landing page + error catalogue from src/knowledge)
scripts/                   demo, real-server smoke test, binaries, UI screenshots
```

## The Run

`Run` (src/core/run.js) is an `EventEmitter`:

```
step:start  { id, name }
step:end    { id, name, status, checks }
step:update { … }                       a finished step gained checks (e.g. clock from a later Date header)
http        { method, url, request, response, durationMs }   already redacted
action      { type: 'open-url' | 'await-paste', … }          the human is needed
done        { flow, meta, sections, diagnosis, http }
```

`AsyncLocalStorage` lets the single HTTP helper report into the current run without threading it through every call — so a new gatherer gets tracing and redaction for free.

| Front-end | Subscribes to | Provides |
|---|---|---|
| CLI | `step:end` → live progress on stderr; result → renderer | system browser, terminal prompt |
| Web UI | everything → Server-Sent Events | browser = "show a button" (popup blockers), prompt = paste form, cancel via `AbortSignal` |
| Tests / demo | result | scripted browser that follows redirects and clicks "Allow", scripted prompt |
| CI (GitHub Action) | result → Markdown in the job summary | — |

## Why the redirect strategy works everywhere

SMART App Launch needs the browser to come back to a redirect URI the *company* registered. smart-doctor never needs to own that URL:

- **loopback** (RFC 8252 §7.3): if the registered URI is `http://localhost|127.0.0.1:PORT/path`, bind exactly that (both IPv4 and IPv6 for `localhost`) and wait.
- **paste-back**: otherwise, keep `state` + PKCE verifier in memory, let the user land on the company page, and accept the pasted URL (or just its query string). `state` and `iss` are validated as a real app must.

## Testing strategy

- **Unit** tests for each check.
- **End-to-end** tests make real HTTP calls to the mock EHR: one scenario per failure mode, for both flows, all client types, both redirect strategies. The scripted browser follows the mock's real redirects and submits its real sign-in form.
- **Safety** tests assert no output or trace ever contains a token, code, verifier, assertion or private key material.
- **UI** API tests (security rules, streamed runs, paste, cancel) + an optional Playwright screenshot script.
- **Binary** smoke test runs the compiled executable through backend, secret and loopback-launch flows.
