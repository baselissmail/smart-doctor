const clientDisabled = {
  id: 'openemr.client_disabled',
  title: 'System client not enabled by an administrator',
  why: 'OpenEMR registers new system (backend) clients as disabled until an administrator enables them.',
  fix: 'In OpenEMR: Administration → System → API Clients, find your client and enable it.',
  weight: 0.25,
  source: 'OpenEMR FHIR_README.md / API_README.md (github.com/openemr/openemr): system clients must be enabled by an administrator.',
};

/** @type {import('./index.js').VendorProfile} */
export default {
  id: 'openemr',
  name: 'OpenEMR',
  match: (u) => /\/apis\/[^/]+\/fhir/i.test(u.pathname) || /openemr/i.test(u.host),
  hints: {
    invalid_client: [clientDisabled],
    unauthorized_client: [clientDisabled],
    any: [
      {
        id: 'openemr.generic_error',
        title: 'OpenEMR reports most assertion problems the same way',
        why: 'OpenEMR typically answers assertion problems with a generic "Client authentication failed" message, so the local checks above are the best guide.',
        fix: 'Fix any failing local checks first, then check the client’s registered JWKS / jwks_uri.',
        weight: 0,
        source: 'https://community.open-emr.org/t/401-client-authentication-failed-when-using-jwt-signed-token/24378',
      },
    ],
  },
};
