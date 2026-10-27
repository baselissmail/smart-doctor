// Compare the local clock with the server's Date header. Assertions carry
// exp/iat, so a skewed clock is a classic silent cause of invalid_client.

import { check, STATUS } from './util.js';

export const SKEW_WARN_SECONDS = 30;
export const SKEW_FAIL_SECONDS = 120;

/**
 * Server time from a response's headers. A Date header served from a cache is
 * the time the response was cached, not now: Age corrects for that, and a cache
 * hit without Age is marked so the check can skip it.
 * @param {Record<string, string>} [headers]
 */
export function serverDateFrom(headers = {}, receivedAt = Date.now()) {
  if (!headers.date) return undefined;
  const ageSeconds = Number(headers.age) > 0 ? Number(headers.age) : undefined;
  const cacheHeaders = [headers['x-cache-status'], headers['x-cache'], headers['cf-cache-status'], headers['x-proxy-cache']]
    .filter(Boolean)
    .join(' ');
  const cached = !ageSeconds && /\bhit\b/i.test(cacheHeaders);
  return { date: headers.date, receivedAt, ...(ageSeconds ? { ageSeconds } : {}), ...(cached ? { cached: true, cacheHeaders } : {}) };
}

/**
 * @param {{ date: string, receivedAt: number, ageSeconds?: number, cached?: boolean, cacheHeaders?: string } | undefined} serverDate
 * @returns {{ skewSeconds?: number, check: import('./util.js').Check }}
 */
export function checkClock(serverDate) {
  if (!serverDate?.date) {
    return { check: check('clock.skew', 'Clock in sync with server', STATUS.SKIP, 'Server sent no Date header.') };
  }
  const serverMs = Date.parse(serverDate.date);
  if (Number.isNaN(serverMs)) {
    return { check: check('clock.skew', 'Clock in sync with server', STATUS.SKIP, `Unparseable Date header: ${serverDate.date}`) };
  }
  if (serverDate.cached) {
    return {
      check: check(
        'clock.skew',
        'Clock in sync with server',
        STATUS.SKIP,
        `The server's Date header came from a cache (${serverDate.cacheHeaders}), so it is not the server's current time.`,
      ),
    };
  }
  // Date has 1s resolution; positive skew = server ahead of us.
  const skewSeconds = Math.round((serverMs + (serverDate.ageSeconds || 0) * 1000 - serverDate.receivedAt) / 1000);
  const abs = Math.abs(skewSeconds);
  const dir = skewSeconds > 0 ? 'ahead of' : 'behind';
  if (abs >= SKEW_FAIL_SECONDS) {
    return {
      skewSeconds,
      check: check(
        'clock.skew',
        'Clock in sync with server',
        STATUS.FAIL,
        `Server clock is ${abs}s ${dir} yours. Assertions expire after at most 5 minutes, so the server may see yours as expired or not yet valid.`,
        'Sync this machine’s clock (NTP). On containers/VMs, check the host clock too.',
        { skewSeconds },
      ),
    };
  }
  if (abs >= SKEW_WARN_SECONDS) {
    return {
      skewSeconds,
      check: check(
        'clock.skew',
        'Clock in sync with server',
        STATUS.WARN,
        `Server clock is ${abs}s ${dir} yours.`,
        'Sync your clock (NTP) to rule this out.',
        { skewSeconds },
      ),
    };
  }
  return {
    skewSeconds,
    check: check('clock.skew', 'Clock in sync with server', STATUS.PASS, `skew ${skewSeconds >= 0 ? '+' : ''}${skewSeconds}s`, undefined, {
      skewSeconds,
    }),
  };
}
