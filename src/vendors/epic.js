/** @type {import('./index.js').VendorProfile} */
export default {
  id: 'epic',
  name: 'Epic',
  match: (u) => /epic/i.test(u.host) || /interconnect/i.test(u.pathname) || /\/api\/FHIR\/(R4|STU3|DSTU2)\b/i.test(u.pathname),
  hints: {
    invalid_client: [
      {
        id: 'epic.client_id_env',
        title: 'Non-production vs production client ID',
        why: 'Epic issues separate non-production and production client IDs for each app. The public sandbox only accepts the non-production ID, and customer environments only accept the ID that was activated there.',
        fix: 'Confirm which client ID you are using and that it matches the environment you are calling.',
        weight: 0.15,
        source:
          'Epic on FHIR documentation (fhir.epic.com → Documentation → OAuth 2.0): apps get separate non-production and production client IDs.',
      },
      {
        id: 'epic.key_propagation',
        title: 'New key or JWKS change not picked up yet',
        why: 'After you upload a key or change the JWKS URL, the change can take time to reach the environment you are calling. Requests can fail with invalid_client until it does.',
        fix: 'Wait and retry later. If it persists, re-check the registration (and that the app was synced to that customer environment).',
        weight: 0.1,
        auth: 'private_key_jwt',
        source: 'https://chat-archive.fhir.org/stream/179166-implementers/topic/oauth2.20backend.20services.html',
      },
      {
        id: 'epic.redirect_token',
        title: 'redirect_uri on the token request not registered',
        why: 'Epic answers invalid_client (not invalid_grant) when the redirect_uri sent with the code exchange is not one registered for this client, so a redirect URI difference can look like a bad secret.',
        fix: 'Send the identical, registered redirect_uri in the authorization request and the token request.',
        weight: 0.05,
        flow: 'launch',
        source:
          'Observed on the public Epic sandbox (fhir.epic.com), October 2026: bad code + registered redirect_uri → invalid_grant; bad code + unregistered redirect_uri → invalid_client.',
      },
      {
        id: 'epic.app_activation',
        title: 'App not activated for this organisation',
        why: 'Apps generally need to be enabled by each customer organisation. Perfectly valid credentials are still rejected where the app is not activated.',
        fix: 'Ask the organisation’s Epic analysts to confirm the app (your client ID) is activated in that environment.',
        weight: 0.05,
        source:
          'Epic on FHIR documentation (fhir.epic.com): customer organisations must download/activate an app before its production client ID works there.',
      },
    ],
  },
};
