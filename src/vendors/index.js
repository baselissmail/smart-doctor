// Vendor quirk profiles: one file per vendor, registered below.
//
// These are HINTS, not facts about any specific installation: every EHR deployment is
// configured differently. Each hint must name a public source (vendor docs, a public
// forum thread, or a behaviour anyone can reproduce on a public sandbox). Never add
// information obtained under an NDA, a vendor agreement or from a customer's private
// environment. test/knowledge.test.js checks every profile's shape.

import epic from './epic.js';
import oracleHealth from './oracle-health.js';
import openemr from './openemr.js';
import athena from './athena.js';

/**
 * A hint can be limited to one flow ('backend' | 'launch') or one client auth method.
 * @typedef {{ id: string, title: string, why: string, fix: string, source: string, weight?: number, flow?: 'backend'|'launch', auth?: string }} VendorHint
 * @typedef {{ id: string, name: string, match: (u: URL) => boolean,
 *   hints: Partial<Record<'invalid_client'|'unauthorized_client'|'invalid_scope'|'any', VendorHint[]>> }} VendorProfile
 */

/** @type {VendorProfile[]} Order matters: the first profile whose match() accepts a URL wins. */
export const VENDORS = [epic, oracleHealth, openemr, athena];

export const GENERIC = { id: 'generic', name: 'Generic SMART server', match: () => true, hints: {} };

/** Pick a vendor profile by explicit id or by URL heuristics. */
export function detectVendor(urls, explicit) {
  if (explicit) {
    const v = VENDORS.find((x) => x.id === explicit || x.name.toLowerCase() === String(explicit).toLowerCase());
    return v || GENERIC;
  }
  for (const raw of urls.filter(Boolean)) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const v = VENDORS.find((x) => x.match(u));
    if (v) return v;
  }
  return GENERIC;
}
