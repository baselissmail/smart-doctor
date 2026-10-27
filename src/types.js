// Shared types, written as JSDoc so the code stays plain JavaScript with no build step.
// Editors pick these up for autocomplete, and `npm run typecheck` checks the code against them.
// No runtime code lives here.

/**
 * @typedef {'private_key_jwt'|'client_secret_basic'|'client_secret_post'|'none'} AuthMethod
 */

/**
 * Everything a run can be configured with. A profile, flags and environment variables are merged
 * into one of these (src/cli.js `resolveOptions`, src/profiles.js `profileToOptions`).
 *
 * @typedef {object} RunOptions
 * @property {'backend'|'launch'} [flow]        Which login to check (default: backend, or launch when a redirect URI is set).
 * @property {string} [fhirBase]                FHIR base URL; everything else is discovered from it.
 * @property {string} [clientId]                The client ID registered for this environment.
 * @property {AuthMethod|string} [auth]         How the client authenticates.
 * @property {string} [keyPath]                 Private key file (used locally, never sent).
 * @property {string} [keyText]                 Private key material (tests and the UI only).
 * @property {string} [kid]                     Key ID registered with the server.
 * @property {string} [alg]                     RS384 or ES384 (default: from the key).
 * @property {string} [jwksUrl]                 The JWKS URL registered for the client.
 * @property {boolean} [jku]                    Send the jku header pointing at jwksUrl.
 * @property {string} [scope]                   Scopes to request.
 * @property {string} [tokenUrl]                Override the discovered token endpoint.
 * @property {string} [aud]                     Reproduce an app's assertion aud (backend).
 * @property {string} [vendor]                  Force a vendor profile id.
 * @property {string} [probePath]               FHIR path to GET after a token (status only).
 * @property {boolean} [probe]                  Launch flow: false skips the FHIR probe.
 * @property {string} [redirectUri]             Launch flow: the exact registered redirect URI.
 * @property {'auto'|'loopback'|'paste'} [redirectMode]
 * @property {number} [waitMs]                  Launch flow: how long to wait for the sign-in.
 * @property {boolean} [testRefresh]            Launch flow: false skips the refresh-token test.
 * @property {string} [secretEnv]               Name of the environment variable holding the secret.
 * @property {string} [secret]                  The client secret (from secretEnv; never from flags).
 * @property {boolean} [tokenRequest]           false = offline (local checks only).
 * @property {number} [timeoutMs]               Network timeout per request.
 * @property {string} [configPath]              The smart-doctor.yaml the options came from.
 */

/** @typedef {{ open(url: string): Promise<void> | void }} BrowserAdapter */
/** @typedef {{ ask(question: string, opts?: { defaultValue?: string }): Promise<string>, close?(): void }} PromptAdapter */

/**
 * How a front-end drives a run: the engine never knows whether it is the CLI, the web UI or a test.
 * @typedef {object} RunContext
 * @property {import('./core/run.js').Run} [run]
 * @property {BrowserAdapter} [browser]   Launch flow: how to open the sign-in page.
 * @property {PromptAdapter} [prompter]   Launch flow: how to ask for the pasted callback URL.
 * @property {AbortSignal} [signal]       Cancels a waiting sign-in.
 */

export {};
