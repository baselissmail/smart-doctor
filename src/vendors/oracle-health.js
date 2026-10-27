/** @type {import('./index.js').VendorProfile} */
export default {
  id: 'oracle-health',
  name: 'Oracle Health (Cerner)',
  match: (u) => /cerner\.com$/i.test(u.hostname) || /cerner/i.test(u.hostname),
  hints: {
    invalid_client: [
      {
        id: 'oracle.auth_method',
        title: 'System account uses a different auth method',
        why: 'Oracle Health system accounts are configured in the developer console with a specific client authentication method. A signed JWT will be rejected if the account is set up for a client secret, and vice versa.',
        fix: 'Check the system account configuration and use the matching auth method.',
        weight: 0.15,
        source:
          'Oracle Health (Cerner) FHIR developer documentation (fhir.cerner.com → Authorization): system accounts and their client authentication.',
      },
      {
        id: 'oracle.tenant',
        title: 'Tenant in the URL does not match the account',
        why: 'The FHIR base URL contains a tenant identifier. The system account must be authorised for that tenant.',
        fix: 'Confirm the tenant ID in your FHIR base and token URLs matches the one your account is provisioned for.',
        weight: 0.1,
        source: 'Oracle Health (Cerner) FHIR developer documentation (fhir.cerner.com): service root URLs are tenant-specific.',
      },
    ],
  },
};
