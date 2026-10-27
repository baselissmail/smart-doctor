// Error responses seen on real servers, and the cause smart-doctor should rank first.
//
// The tests check every entry, and the website shows them on each cause's page, because
// people search for the exact message they got. Add the exact body you saw and where
// (public sandbox or product + version). Never include client IDs, tokens or anything
// from a customer's environment.

/** @type {{ where: string, body: { error: string, error_description?: string }, expect: string }[]} */
export const SEEN = [
  {
    where: 'SMART launcher (launch.smarthealthit.org)',
    body: { error: 'invalid_client', error_description: 'None of the keys found in the JWKS have kid equal to sandbox-typo' },
    expect: 'kid_unknown',
  },
  {
    where: 'SMART launcher (launch.smarthealthit.org)',
    body: { error: 'invalid_client', error_description: 'None of the keys found in the JWKS have alg equal to RS384' },
    expect: 'jwks_no_alg',
  },
  {
    where: 'SMART launcher (launch.smarthealthit.org)',
    body: { error: 'invalid_client', error_description: "Invalid 'client_id' (as sub claim of the assertion JWT)" },
    expect: 'client_unknown',
  },
  {
    where: 'SMART launcher (launch.smarthealthit.org)',
    body: { error: 'invalid_request', error_description: 'Basic authentication is required for confidential clients' },
    expect: 'secret_method_required',
  },
  {
    where: 'SMART launcher (launch.smarthealthit.org)',
    body: {
      error: 'invalid_client',
      error_description: "Invalid token 'aud' value (https://ehr.example/auth/token/). Must be 'https://ehr.example/auth/token'.",
    },
    expect: 'aud_mismatch',
  },
  {
    where: 'SMART launcher (launch.smarthealthit.org)',
    body: { error: 'invalid_client', error_description: 'Invalid client_secret in the basic auth header' },
    expect: 'secret_invalid',
  },
  { where: 'OpenEMR', body: { error: 'invalid_client', error_description: 'Client authentication failed' }, expect: 'generic_client_auth' },
  { where: 'Epic public sandbox (fhir.epic.com)', body: { error: 'invalid_grant' }, expect: 'code_consumed' },
  {
    where: 'Public vendor sandbox',
    body: { error: 'invalid_grant', error_description: 'authorization code has already been used or has expired' },
    expect: 'code_expired',
  },
  {
    where: 'Public vendor sandbox',
    body: { error: 'invalid_request', error_description: 'Authorization code in the request is not valid' },
    expect: 'code_consumed',
  },
  { where: 'Public vendor sandbox', body: { error: 'Invalid Grant' }, expect: 'code_consumed' },
  { where: 'Public vendor sandbox', body: { error: 'invalid_code' }, expect: 'code_consumed' },
];
