# Releasing (maintainers)

Releases are cut from `main` by pushing a version tag; GitHub Actions does the rest.

## One-time setup

1. **npm** — publish the first version by hand so the package exists: `npm login`, then `npm publish --access public` from a clean checkout of the tagged commit.
2. Then, on npmjs.com → the package → *Settings → Trusted publishing*, add GitHub Actions: repository `baselissmail/smart-doctor`, workflow `release.yml`, environment `npm`. From then on the workflow publishes with provenance and no npm token is stored anywhere. Optionally disallow token-based publishing.
3. **GitHub** — create an environment named `npm` (Settings → Environments), optionally with a required reviewer so every publish needs a click. Enable *Private vulnerability reporting* (Settings → Security), *Discussions*, and *Pages* with source "GitHub Actions".

## Every release

1. Move the **Unreleased** entries in `CHANGELOG.md` under the new version with today's date.
2. `npm version <patch|minor|major> --no-git-tag-version`, then set the same version in `src/version.js` and `.claude-plugin/plugin.json` (a test checks all three match). Commit (`chore: release vX.Y.Z`), push to `main`, wait for CI.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The Release workflow checks the tag matches `package.json`, runs `npm run check`, builds and smoke-tests the binaries, creates the GitHub release with checksums, and publishes to npm with provenance.
5. Move the GitHub Action's major tag so `uses: baselissmail/smart-doctor@v0` picks up the release: `git tag -f v0 && git push -f origin v0`.
6. Check the release page, `npm view smart-doctor version`, and the website.
