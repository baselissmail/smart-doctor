# Roadmap

Where smart-doctor is heading. Items marked **help wanted** are good places to start — comment on the linked discussion or open one before starting something large.

## Next

- **Check credentials before anyone signs in.** Send a deliberately invalid code, then the same request with a deliberately wrong secret as a control: either "your client ID and secret are right" or "this server checks the code first, so only a real sign-in can tell". Saves booking a clinician to discover a typo. *help wanted*
- **EHR launch** (launch from inside the EHR): `iss` and `launch` parameters, launch context, and the failures specific to it. Today only standalone launch is covered.
- **Trace through an identity broker or proxy.** Many apps put Cognito, Auth0, Okta, Entra ID or their own proxy in front of the EHR. Start from the URL your app really uses, follow every hop (redirects and auto-submitting forms) without logging in, and check what the EHR finally receives: `aud`, `launch`, `redirect_uri`, `state`, PKCE, and that the endpoint is the one the FHIR server advertises.
- **Explain the EHR's error page.** When the browser stops on an error page there's nothing to paste back; let `explain` take the page text (e.g. Epic's "OAuth2 Error") instead. *help wanted*

## Later

- **Stricter type checking.** `npm run typecheck` passes today; the next steps are `strictNullChecks` (about 70 places need a typed result object rather than a code change) and then `noImplicitAny`. Good first contributions, one file at a time. *help wanted*

- More vendor knowledge from public sandboxes and public documentation (MEDITECH, NextGen, Veradigm and others). *help wanted*
- Saved run history in the local web view, to compare a failing run with the last good one.
- Homebrew tap and winget/Scoop manifests for the standalone binaries.
- Bulk Data `$export` kick-off and status checks for backend apps.
- UDAP / dynamic client registration checks.

## Not planned

- Anything that needs a cloud service, an account or telemetry: smart-doctor stays local-first.
- Storing or displaying FHIR resource contents: the probe reports status codes only, by design.
