// The cause catalogue: every explanation smart-doctor can give (knowledge as data).
//
// Each entry is what a person reads in a report: a short title, why it happens, and what to
// do. diagnose.js decides WHEN a cause applies and how likely it is; this file only says
// WHAT it means. Keep the tone plain and the fix actionable. Ids are stable (used in JSON
// output, tests and the website's error catalogue), so rename only with care.

/**
 * Where in a login each cause happens, in the order a login runs. Used to group the
 * website's error catalogue; every cause has one.
 */
export const STAGES = [
  { id: 'connection', title: 'Reaching the server', blurb: 'Before any login: the network, the FHIR base URL and the token endpoint.' },
  { id: 'secret', title: 'Client secrets', blurb: 'Confidential clients that authenticate with a client secret.' },
  { id: 'keys', title: 'Keys and JWKS', blurb: 'Your signing key, the public JWKS the server reads, and how the two match.' },
  { id: 'assertion', title: 'The signed client assertion', blurb: 'The private_key_jwt the server checks on every token request.' },
  {
    id: 'registration',
    title: 'Client registration',
    blurb: 'What the server knows about your client, which you cannot see from outside.',
  },
  { id: 'scopes', title: 'Scopes', blurb: 'What you ask for versus what the registration allows.' },
  { id: 'signin', title: 'Sign-in at the EHR', blurb: 'The authorization request, the redirect back, and its state.' },
  { id: 'exchange', title: 'Code exchange', blurb: 'Turning the authorization code into tokens.' },
  {
    id: 'after',
    title: 'Tokens, context and access',
    blurb: 'What came back: patient context, id_token, refresh token, and the first FHIR call.',
  },
];

/** @typedef {{ stage: string, title: string, why: string, fix: string }} CauseText */

/** @type {Record<string, CauseText>} */
export const CAUSES = {
  jwks_private_leak: {
    stage: 'keys',
    title: 'Your public JWKS is leaking your PRIVATE key',
    why: 'The JWKS URL publishes private key fields (e.g. "d"). Anyone can sign as your app.',
    fix: 'Remove it now, rotate to a new key pair, and register the new public key. Treat the old key as compromised.',
  },
  network: {
    stage: 'connection',
    title: 'Cannot reach the server',
    why: 'The request never got an HTTP answer (DNS, firewall, VPN, proxy, or TLS problem).',
    fix: 'Check the URL, VPN/firewall rules, HTTPS_PROXY, and CA certificates (NODE_EXTRA_CA_CERTS for corporate proxies).',
  },
  wrong_base: {
    stage: 'connection',
    title: 'FHIR base URL is wrong',
    why: 'Neither .well-known/smart-configuration nor /metadata exposed a token endpoint.',
    fix: 'Use the exact FHIR base (often ends in /R4 or /api/FHIR/R4), or pass --token-url.',
  },
  wrong_token_url: {
    stage: 'connection',
    title: 'Token URL is wrong',
    why: 'The token endpoint answered 404/405 or HTML instead of an OAuth JSON response.',
    fix: 'Use the token_endpoint from the server’s .well-known/smart-configuration.',
  },
  token_url_differs: {
    stage: 'connection',
    title: 'You are using a token URL the server does not advertise',
    why: 'Your --token-url differs from the server’s advertised token_endpoint. aud must equal the endpoint you post to, and some servers only accept the advertised one.',
    fix: 'Use the advertised token_endpoint for both the POST and the aud claim.',
  },
  aud_mismatch: {
    stage: 'assertion',
    title: 'aud does not exactly match the token endpoint',
    why: 'The assertion’s aud must be the token endpoint URL, character for character (trailing slash, case, http/https and path all matter).',
    fix: 'Set aud to the exact token_endpoint string from the SMART configuration.',
  },
  kid_missing: {
    stage: 'keys',
    title: 'No kid in the assertion header',
    why: 'Without a kid the server cannot pick your key from the JWKS.',
    fix: 'Add the kid of your registered key to the JWT header (--kid).',
  },
  kid_unknown: {
    stage: 'keys',
    title: 'Your kid is not in the JWKS the server knows about',
    why: 'The server looks up the kid from your header in your registered JWKS and does not find it.',
    fix: 'Publish the key with that kid, or sign with a kid that is published.',
  },
  key_mismatch: {
    stage: 'keys',
    title: 'Signing key does not match the published public key',
    why: 'The key under your kid is not the public half of the private key you sign with, so the signature fails.',
    fix: 'Sign with the matching private key, or publish the correct public key (--show-public-jwk prints it).',
  },
  signature: {
    stage: 'keys',
    title: 'Signature could not be verified',
    why: 'The server found a key but the signature did not verify against it (wrong key, wrong alg, or a mangled token).',
    fix: 'Check that the registered public key matches your private key and that alg matches the key type.',
  },
  jwks_fetch: {
    stage: 'keys',
    title: 'The server cannot fetch your JWKS',
    why: 'Your JWKS URL is unreachable, not HTTPS, redirects, or is not valid JSON — the EHR fetches it from the public internet.',
    fix: 'Serve the JWKS at a public HTTPS URL that returns 200 JSON without auth or redirects.',
  },
  jwks_no_alg: {
    stage: 'keys',
    title: 'No key for your algorithm in the registered JWKS',
    why: 'The server read your registered JWKS but found no key for the algorithm you sign with (for example you sign RS384 but registered an EC key). You are probably signing with a different key than the one registered.',
    fix: 'Sign with the private key whose public half is registered, or register this key (--show-public-jwk prints it).',
  },
  alg_unsupported: {
    stage: 'keys',
    title: 'Signing algorithm not accepted',
    why: 'The server does not list your alg in token_endpoint_auth_signing_alg_values_supported, or the alg does not match the key.',
    fix: 'Use RS384 (RSA) or ES384 (EC P-384), whichever the server advertises.',
  },
  auth_method: {
    stage: 'secret',
    title: 'Server does not support this client authentication method',
    why: 'Your --auth method is not in the server’s token_endpoint_auth_methods_supported.',
    fix: 'Check how your client was registered (signed JWT vs client secret) and pass the matching --auth.',
  },
  secret_missing: {
    stage: 'secret',
    title: 'No client secret provided',
    why: 'Secret-based client authentication was selected but no secret was available.',
    fix: 'Set the secret in an environment variable (default SMART_DOCTOR_CLIENT_SECRET) — never as a command-line flag.',
  },
  secret_whitespace: {
    stage: 'secret',
    title: 'Client secret has stray whitespace',
    why: 'Leading or trailing spaces/newlines from copy-paste make an otherwise correct secret fail.',
    fix: 'Re-copy the secret exactly.',
  },
  secret_invalid: {
    stage: 'secret',
    title: 'Client secret rejected',
    why: 'The secret is wrong for this client_id: rotated or expired, from another environment, or for a different app.',
    fix: 'Regenerate or re-copy the secret for this exact client_id and environment from the vendor portal.',
  },
  secret_method_required: {
    stage: 'secret',
    title: 'Server wants the client secret sent another way',
    why: 'The server named the client authentication it requires (for example HTTP Basic). The secret itself may well be right.',
    fix: 'Switch --auth to the method the server names: client_secret_basic sends the secret in the Authorization header, client_secret_post in the form body.',
  },
  secret_method: {
    stage: 'secret',
    title: 'Basic vs post mismatch',
    why: 'The server may only accept the secret in the Authorization header (client_secret_basic) or only in the body (client_secret_post), or may decode Basic credentials differently.',
    fix: 'Re-run with the other --auth method to rule this out.',
  },
  clock_skew: {
    stage: 'assertion',
    title: 'Clock skew between you and the server',
    why: 'Assertions live at most 5 minutes; a skewed clock makes them look expired or not yet valid.',
    fix: 'Sync your clock (NTP), including container/VM hosts.',
  },
  assertion_time: {
    stage: 'assertion',
    title: 'Assertion expired, too long-lived, or not yet valid',
    why: 'exp must be in the future and at most 5 minutes out; iat/nbf must not be in the future.',
    fix: 'Create a fresh assertion per request with exp = now + ≤300s, and check your clock.',
  },
  jti_reuse: {
    stage: 'assertion',
    title: 'jti reused',
    why: 'Servers reject an assertion whose jti they have already seen.',
    fix: 'Generate a new random jti (UUID) for every token request; don’t cache assertions.',
  },
  iss_sub: {
    stage: 'assertion',
    title: 'iss/sub is not your client_id',
    why: 'Both iss and sub must equal the client_id registered for this environment.',
    fix: 'Set iss = sub = client_id.',
  },
  client_unknown: {
    stage: 'registration',
    title: 'Wrong client_id for this environment',
    why: 'The server does not recognise this client_id (non-production vs production IDs, or a typo).',
    fix: 'Double-check the client_id for the environment you are calling.',
  },
  client_inactive: {
    stage: 'registration',
    title: 'Client exists but is not enabled/authorised',
    why: 'The client is registered but disabled, not activated for this organisation, or not allowed to use client_credentials.',
    fix: 'Ask the server administrator to enable/activate the client for backend services.',
  },
  server_side_registration: {
    stage: 'registration',
    title: 'Server-side registration does not match (what we cannot see)',
    why: 'Every check we can do locally passes, so the remaining causes live in the server’s registration: wrong environment client_id, a different public key on file, a key/JWKS change not picked up yet, or the app not activated.',
    fix: 'Compare the registration in the vendor portal with the values printed here (client_id, kid, key thumbprint, JWKS URL).',
  },
  registered_key_unknown: {
    stage: 'keys',
    title: 'The public key on file may not be this key',
    why: 'No --jwks-url was given, so smart-doctor cannot compare the key the server has with your private key.',
    fix: 'Compare the thumbprint printed here with the key uploaded to the vendor portal, or pass --jwks-url.',
  },
  scope: {
    stage: 'scopes',
    title: 'Requested scopes not allowed',
    why: 'The client is not registered for one or more requested scopes, or the scope syntax is not what this server expects.',
    fix: 'Request only scopes your registration includes. Note SMART v1 (system/*.read) vs v2 (system/*.rs) syntax.',
  },
  scope_syntax: {
    stage: 'scopes',
    title: 'Scope syntax version may not match the server',
    why: 'You used SMART v2 scope syntax (.rs/.cruds) but the server only advertises v1, or vice versa.',
    fix: 'Match the server: v1 uses .read/.write/.*; v2 uses .c/.r/.u/.d/.s combinations.',
  },
  scope_partial: {
    stage: 'scopes',
    title: 'Fewer scopes granted than requested',
    why: 'The token was issued but without some requested scopes; calls needing them will get 403.',
    fix: 'Add the missing scopes to the client registration, or stop requesting them.',
  },
  grant_type: {
    stage: 'registration',
    title: 'client_credentials grant not allowed',
    why: 'The server rejected the grant type for this client or endpoint.',
    fix: 'Make sure the client is registered as a backend/system app that may use client_credentials.',
  },
  rate_limited: {
    stage: 'connection',
    title: 'Rate limited',
    why: 'The server answered 429 Too Many Requests.',
    fix: 'Cache tokens until they expire instead of requesting one per call; back off and retry after the Retry-After interval.',
  },
  server_error: {
    stage: 'connection',
    title: 'Server-side error',
    why: 'The token endpoint returned a 5xx error; this is usually not your request.',
    fix: 'Retry later; if it persists, open a ticket with the vendor including the timestamp and your client_id.',
  },
  probe_failed: {
    stage: 'after',
    title: 'Token works, but the FHIR call was refused',
    why: 'A token was issued, yet the probe request was rejected (401/403).',
    fix: 'Check the scopes granted for this resource and that the token is used against the matching FHIR base.',
  },
  // ---- SMART App Launch ----
  redirect_not_registered: {
    stage: 'signin',
    title: 'The EHR never sent the browser back: redirect URI not registered exactly',
    why: 'When redirect_uri does not match a registered value character for character, EHRs show their own error page and never redirect. Scheme, host (localhost vs 127.0.0.1), port, path and trailing slash all count.',
    fix: 'Copy the registered redirect URI from the vendor portal and use exactly that string (--redirect-uri).',
  },
  signin_not_completed: {
    stage: 'signin',
    title: 'Sign-in was not completed',
    why: 'The browser was not used to finish signing in (closed tab, wrong account, login failure, or MFA timeout).',
    fix: 'Run again and complete sign-in in the browser window that opens.',
  },
  loopback_port: {
    stage: 'signin',
    title: 'Cannot listen on the redirect port',
    why: 'Another program is using the port in your loopback redirect URI, or it needs admin rights.',
    fix: 'Close the program using it, or register a different loopback port.',
  },
  access_denied: {
    stage: 'signin',
    title: 'Access denied at sign-in',
    why: 'The user declined, or this user/organisation is not allowed to use the app.',
    fix: 'Sign in as a user who is authorised for this app, and approve the request.',
  },
  authorize_scope: {
    stage: 'signin',
    title: 'Scopes rejected at sign-in',
    why: 'One or more requested scopes are not allowed for this app at this EHR.',
    fix: 'Request only the scopes in the app registration (check v1 vs v2 syntax and launch/patient vs launch).',
  },
  authorize_client: {
    stage: 'signin',
    title: 'App not allowed to sign in this way',
    why: 'unauthorized_client: the app is not enabled for this flow, not activated at this organisation, or registered as a different client type.',
    fix: 'Check the registration: standalone launch enabled, correct client type (public/confidential), activated for this environment.',
  },
  authorize_request: {
    stage: 'signin',
    title: 'Authorization request rejected',
    why: 'The EHR refused the sign-in request itself, before anyone signed in. Its error description is the best clue; common culprits are aud (must equal the FHIR base URL), PKCE, or a parameter the EHR does not expect.',
    fix: 'Read the error description; check aud equals the FHIR base URL exactly.',
  },
  authorize_redirect: {
    stage: 'signin',
    title: 'Redirect URI rejected at sign-in',
    why: 'The EHR says the redirect_uri is not registered for this app. It must match a registered value character for character: scheme, host (localhost vs 127.0.0.1), port, path and trailing slash all count.',
    fix: 'Copy the registered redirect URI from the vendor portal and use exactly that string (--redirect-uri).',
  },
  authorize_aud: {
    stage: 'signin',
    title: 'aud rejected at sign-in',
    why: 'SMART EHRs require aud to be the FHIR base URL the app talks to, exactly as the EHR expects it (trailing slash, http vs https, version path).',
    fix: 'Check the FHIR base URL (--fhir): smart-doctor sends it as aud.',
  },
  state_mismatch: {
    stage: 'signin',
    title: 'state does not match',
    why: 'The pasted callback came from a different sign-in attempt (another tab or an earlier run). smart-doctor refuses it, as a real app must.',
    fix: 'Use one tab and paste the URL from the latest attempt.',
  },
  iss_mismatch: {
    stage: 'signin',
    title: 'Callback came from a different server',
    why: 'The iss parameter names another authorization server — a mix-up an app must reject.',
    fix: 'Check the FHIR base URL matches the EHR you signed in to.',
  },
  bad_paste: {
    stage: 'signin',
    title: 'The pasted URL is incomplete',
    why: 'The callback URL needs its query string (code=… and state=…).',
    fix: 'Copy the entire address-bar URL right after the redirect.',
  },
  code_consumed: {
    stage: 'exchange',
    title: 'Authorization code already used',
    why: 'Codes are single-use. If the company’s redirect page is a live app, it probably exchanged the code itself before you pasted it.',
    fix: 'For testing, register a loopback redirect (http://localhost:PORT/callback) or a redirect page that does nothing, then use that.',
  },
  code_expired: {
    stage: 'exchange',
    title: 'Authorization code expired',
    why: 'Codes are short-lived (often 1–10 minutes).',
    fix: 'Paste the callback URL promptly after signing in.',
  },
  redirect_mismatch_token: {
    stage: 'exchange',
    title: 'redirect_uri differs between sign-in and token exchange',
    why: 'The token request must send the identical redirect_uri used in the authorization request.',
    fix: 'Use one exact string in both requests (your app may be normalising it, e.g. adding a slash).',
  },
  pkce_failed: {
    stage: 'exchange',
    title: 'PKCE verification failed',
    why: 'The code_verifier does not hash to the code_challenge sent at sign-in.',
    fix: 'Use base64url (no padding) SHA-256 of the exact verifier, and keep the verifier per attempt.',
  },
  s256_unsupported: {
    stage: 'signin',
    title: 'Server does not advertise PKCE S256',
    why: 'SMART App Launch v2 requires S256. The server may be SMART v1 only or misconfigured.',
    fix: 'Check the vendor’s SMART version; ask whether S256 is supported.',
  },
  missing_patient: {
    stage: 'after',
    title: 'No patient context returned',
    why: 'launch/patient was requested but no patient came back — the scope may not have been granted, or no patient was chosen.',
    fix: 'Confirm launch/patient is in the registration and a patient is selected during sign-in.',
  },
  id_token_problem: {
    stage: 'after',
    title: 'id_token problem',
    why: 'openid was requested but the id_token is missing, for another audience, or does not verify.',
    fix: 'Check openid/fhirUser are granted, and that the app verifies id_tokens against the server’s jwks_uri.',
  },
  refresh_problem: {
    stage: 'after',
    title: 'Refresh tokens not working',
    why: 'offline_access/online_access was requested but no usable refresh token was issued.',
    fix: 'Check the scope is granted for this client type; some servers only give refresh tokens to confidential clients.',
  },
  refresh_rejected: {
    stage: 'after',
    title: 'Refresh token rejected',
    why: 'A refresh token was issued, but using it failed: it may have expired or been revoked, be single-use (rotated on each refresh), or the server may expect client authentication on refresh.',
    fix: 'Check the refresh token lifetime and rotation policy for this client; confidential clients must authenticate on refresh too.',
  },
  unrecognised_error: {
    stage: 'connection',
    title: 'The server’s error is not one smart-doctor recognises',
    why: 'The server rejected the request with an error smart-doctor has no rule for, so it cannot rank causes. The server’s own wording is the best lead.',
    fix: 'Search the vendor documentation for this error and run with --verbose to see the full response. If you work it out, please open an issue so smart-doctor learns it.',
  },
  generic_client_auth: {
    stage: 'assertion',
    title: 'Generic client authentication failure',
    why: 'The server reports a generic failure that covers many assertion problems.',
    fix: 'Fix any failing local checks; then compare the server registration (client_id, JWKS/kid, key).',
  },
};
