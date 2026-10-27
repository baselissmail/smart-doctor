// Scripted "human with a browser": follows redirects, submits the mock EHR's
// sign-in form, and when it reaches the redirect URI either delivers the
// request (loopback) or remembers the URL so a scripted prompter can paste it.
// Used by the demo and the tests; never by real runs.

/** @param {{ redirectUri?: string, decision?: string, patient?: string, deliver?: boolean }} [opts]  decision: 'approve' or 'deny' */
export function fakeBrowser({ redirectUri, decision = 'approve', patient, deliver = true } = {}) {
  let resolveLanded;
  const landed = new Promise((r) => (resolveLanded = r));
  const b = {
    visited: [],
    stuckOn: undefined, // an error page the user would be looking at
    landed, // resolves with the callback URL
    async open(url) {
      let next = url;
      let method = 'GET';
      let body;
      for (let i = 0; i < 10; i++) {
        if (redirectUri && next.split('?')[0] === redirectUri.split('?')[0]) {
          resolveLanded(next);
          if (deliver) await fetch(next).catch(() => {});
          return;
        }
        b.visited.push(next);
        const res = await fetch(next, {
          method,
          body,
          redirect: 'manual',
          headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
        });
        method = 'GET';
        body = undefined;
        if (res.status >= 300 && res.status < 400) {
          next = new URL(res.headers.get('location'), next).toString();
          continue;
        }
        const html = await res.text();
        const form = html.match(/<form method="post" action="([^"]+)">/);
        if (res.ok && form) {
          const id = html.match(/name="id" value="([^"]+)"/)[1];
          const p = new URLSearchParams({ id, decision });
          const firstPatient = html.match(/name="patient" value="([^"]+)"/);
          if (patient || firstPatient) p.set('patient', patient || firstPatient[1]);
          next = new URL(form[1], next).toString();
          method = 'POST';
          body = p.toString();
          continue;
        }
        b.stuckOn = { status: res.status, html };
        return; // a human would now be staring at an error page
      }
    },
  };
  return b;
}

/** A prompter that "pastes" whatever URL the fake browser landed on. */
export function pastePrompter(browser, transform = (u) => u) {
  return {
    async ask() {
      return transform(await browser.landed);
    },
  };
}
