/** @type {import('./index.js').VendorProfile} */
export default {
  id: 'athena',
  name: 'athenahealth',
  match: (u) => /athenahealth\.com$/i.test(u.hostname),
  hints: {
    invalid_client: [
      {
        id: 'athena.auth_method',
        title: 'App configured for a different auth method',
        why: 'Confirm in the developer portal how your app authenticates (client secret vs signed JWT) and which environment (preview vs production) its credentials belong to.',
        fix: 'Use the auth method and credentials for the environment you are calling.',
        weight: 0.1,
        source:
          'athenahealth developer portal documentation (docs.athenahealth.com): separate preview and production environments and credentials.',
      },
    ],
  },
};
