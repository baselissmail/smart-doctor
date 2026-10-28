# Contributing

Thanks for helping make EHR integration less painful. Every login failure someone figured out the hard way is worth teaching smart-doctor, and most contributions are a few lines of data plus a test.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Questions and ideas are welcome in [Discussions](https://github.com/baselissmail/smart-doctor/discussions); security problems go to [SECURITY.md](SECURITY.md), never to a public issue.

## Get set up (2 minutes)

You need Node.js 22 or newer.

```bash
git clone https://github.com/baselissmail/smart-doctor.git && cd smart-doctor
npm install
npm run check        # lint + type check + format check + all tests, no network needed
npm run demo         # 25 broken logins and what smart-doctor concludes
npm run ui           # the local web view with the practice EHR
```

Optional, needs internet: `npm run smoke:sandbox` runs 16 deliberate breakages against the public SMART launcher. `npm run site` builds and serves the website at <http://localhost:4400>.

## Where to add what

smart-doctor keeps its knowledge as data, so most changes don't touch the engine.

| You want to… | Edit | Prove it with |
|---|---|---|
| Teach it a server's error message | `TEXT_PATTERNS` or `ERROR_ALIASES` in [`src/knowledge/errors.js`](src/knowledge/errors.js) | one line in `SEEN_ON_REAL_SERVERS` in [`test/knowledge.test.js`](test/knowledge.test.js) |
| Add or improve a vendor hint | the vendor's file in [`src/vendors/`](src/vendors/) (new vendor: add a file and register it in `index.js`) | `test/knowledge.test.js` checks the shape; add a detection case there |
| Reword an explanation or fix | [`src/knowledge/causes.js`](src/knowledge/causes.js) | the website and reports pick it up automatically |
| Add a new cause | `causes.js` for the words, [`src/diagnose.js`](src/diagnose.js) for when it applies | a unit test in `test/unit.test.js`, or an end-to-end test below |
| Reproduce a new failure end to end | add a mode to `MODES` in [`src/mock/server.js`](src/mock/server.js) | `test/integration.test.js` (backend) or `test/launch.test.js` (sign-in) asserting the top cause |
| Harden code that parses untrusted input | a property in [`test/properties.test.js`](test/properties.test.js) ([fast-check](https://fast-check.dev/)) | `npm test` runs it with hundreds of generated inputs |
| Check against a real public server | a scenario in [`scripts/sandbox-smoke.mjs`](scripts/sandbox-smoke.mjs) | `npm run smoke:sandbox` |
| Change the CLI, web UI or a flow | see [ARCHITECTURE.md](ARCHITECTURE.md) first | tests next to the existing ones |

### Rules for knowledge

1. **Public sources only.** Every vendor hint has a `source`: public vendor documentation, a public forum thread, or behaviour anyone can reproduce on a public sandbox. Never contribute information obtained under an NDA, a vendor agreement, or from a customer's private environment.
2. **No real identifiers.** No keys, secrets, tokens, client IDs, tenant IDs, endpoints or organisation names from real customers, and no patient data — not even "anonymised" samples. Use the practice EHR or public sandboxes.
3. **Hints are possibilities, not verdicts.** Write "can" and "often"; every installation is configured differently. Keep vendor hint `weight` between 0 and 0.3.
4. **Plain words.** Reports are read by stressed people mid-incident: say what's wrong, why, and the exact next step.

## Making a change

1. For anything bigger than a fix or a knowledge entry, open an issue or discussion first so we can agree on the approach.
2. Branch from `main`, keep the change focused, and add a test that fails without it.
3. Run `npm run check`. CI runs the same on Linux, macOS and Windows with Node 22 and 24.
4. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) if users will notice.
5. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix(diagnose): …`, `feat(vendors): …`, `docs: …`).
6. Open a pull request; the template has a short checklist. `main` only accepts pull requests that pass CI, and they are squash-merged, so your PR title becomes the commit message.

Code style is enforced by Prettier and ESLint (`npm run format` fixes formatting). The code is plain JavaScript (ES modules) with no build step and very few dependencies — please keep it that way; a new runtime dependency needs a good reason.

Types are JSDoc comments, checked by TypeScript (`npm run typecheck`, also in CI). Shared shapes such as `RunOptions` live in [`src/types.js`](src/types.js); give new functions with option objects a `@param` type so editors can autocomplete them. Why JavaScript and not TypeScript files: what you read is exactly what runs (in the npm package, the binaries and the Action), and Node will not run `.ts` files from inside `node_modules`, so TypeScript sources would need a build step.

## Safety is a feature

smart-doctor handles private keys and secrets, so a few rules are non-negotiable and covered by tests:

- secrets come from environment variables (or the local UI's password field), never from flags or files we write;
- every HTTP exchange is redacted inside the engine before any front-end sees it;
- the FHIR probe records the status only, never a body.

If a change touches any of this, say so in the PR and add a test in `test/integration.test.js` or `test/launch.test.js` that proves nothing leaks.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), like the rest of the project.
