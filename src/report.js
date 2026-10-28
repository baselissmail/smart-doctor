// Renderers: human (terminal), JSON, and a paste-safe Markdown report.
// Nothing here ever prints a private key, a client secret, an access token,
// an authorization code, or an assertion — the HTTP trace is redacted at the
// source (core/redact.js) and these renderers only add client_id masking.

import { STATUS, redactId } from './util.js';

const ICON = { pass: '✔', fail: '✖', warn: '!', info: 'i', skip: '-', running: '…' };
const COLORS = { pass: 32, fail: 31, warn: 33, info: 36, skip: 90 };

const FLOW_LABEL = {
  backend: 'SMART backend services check',
  launch: 'SMART App Launch check',
};

const VERDICT_TEXT = {
  backend: {
    ok: 'Result: token obtained — backend services login works.',
    warn: 'Result: token obtained, but with warnings.',
    offline: 'Result: offline checks passed (no token request made).',
    fail: 'Result: login fails.',
  },
  launch: {
    ok: 'Result: sign-in and token exchange work.',
    warn: 'Result: tokens obtained, but with warnings.',
    offline: 'Result: offline checks passed (sign-in not attempted).',
    fail: 'Result: the launch fails.',
  },
};

function paint(on) {
  const c = (code, s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    status: (st, s) => c(COLORS[st] || 0, s),
    bold: (s) => c(1, s),
    dim: (s) => c(90, s),
  };
}

export function confidenceLabel(x) {
  if (x >= 0.8) return 'very likely';
  if (x >= 0.6) return 'likely';
  if (x >= 0.4) return 'possible';
  return 'less likely';
}

/**
 * When redacting, mask the client id and the patient, encounter and user ids a sign-in returned,
 * wherever they appear (check details, the token response, the probe URL).
 */
function scrubber(meta, redact) {
  if (!redact) return (t) => t;
  const swap = new Map((meta?.identifiers || []).map((v) => [String(v), '[masked id]']));
  if (meta?.clientId) swap.set(String(meta.clientId), redactId(meta.clientId));
  if (!swap.size) return (t) => t;
  const alts = [...swap.keys()].sort((a, b) => b.length - a.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Whole values only: a client id "app" must not mask the "app" in "application/json".
  const re = new RegExp(`(?<![\\w.-])(?:${alts.join('|')})(?![\\w.-])`, 'g');
  return (t) => (typeof t === 'string' ? t.replace(re, (m) => swap.get(m) ?? m) : t);
}

function safeMeta(meta, redact) {
  return {
    flow: meta.flow || 'backend',
    clientId: redact ? redactId(meta.clientId) : meta.clientId,
    fhirBase: meta.fhirBase,
    tokenUrl: meta.tokenUrl,
    authorizeUrl: meta.authorizeUrl,
    redirectUri: meta.redirectUri,
    redirectMode: meta.redirectMode,
    auth: meta.auth,
    vendor: meta.vendor?.name,
    alg: meta.alg,
    kid: meta.kid,
    thumbprint: meta.thumbprint,
  };
}

/** One HTTP exchange as terminal lines. */
export function formatExchange(x, p = paint(false)) {
  const lines = [];
  lines.push(`${p.bold('→')} ${x.method} ${x.url}${x.label ? p.dim(`  (${x.label})`) : ''}`);
  for (const [k, v] of Object.entries(x.request?.headers || {})) lines.push(p.dim(`    ${k}: ${v}`));
  if (x.request?.body) lines.push(indent(x.request.body, '    '));
  if (x.response?.error) {
    lines.push(`${p.status('fail', '←')} network error: ${x.response.error} ${p.dim(`(${x.durationMs} ms)`)}`);
  } else {
    const st = x.response.status >= 400 ? 'fail' : x.response.status >= 300 ? 'warn' : 'pass';
    lines.push(`${p.status(st, '←')} ${x.response.status} ${p.dim(`(${x.durationMs} ms)`)}`);
    for (const [k, v] of Object.entries(x.response.headers || {})) lines.push(p.dim(`    ${k}: ${v}`));
    if (x.response.body) lines.push(indent(x.response.body, '    '));
  }
  return lines.join('\n');
}

const indent = (text, pad) =>
  String(text)
    .split('\n')
    .map((l) => pad + l)
    .join('\n');

/** Human-readable terminal output. */
/** The checks, section by section (shared by the full report and `inspect`). */
function sectionLines(sections, p, sc = (/** @type {string} */ s) => s) {
  const lines = [];
  for (const s of sections) {
    lines.push(p.bold(s.name));
    for (const c of s.checks) {
      lines.push(`  ${p.status(c.status, ICON[c.status] || '?')} ${sc(c.title)}${c.detail ? p.dim(' — ') + sc(c.detail) : ''}`);
      if (c.fix && (c.status === STATUS.FAIL || c.status === STATUS.WARN)) lines.push(`      ${p.dim('fix:')} ${c.fix}`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Render sections of checks without a verdict or causes (the `inspect` command).
 * @param {{ name: string, checks: import('./util.js').Check[] }[]} sections
 * @param {{ color?: boolean }} [opts]
 */
export function renderChecks(sections, { color = false } = {}) {
  return sectionLines(sections, paint(color)).join('\n');
}

export function renderHuman(result, { color = false, redact = false, showPublicJwk = false, verbose = false, maxCauses = 5 } = {}) {
  const p = paint(color);
  const lines = [];
  const m = safeMeta(result.meta, redact);
  const sc = scrubber(result.meta, redact);
  lines.push(p.bold('smart-doctor') + p.dim(` — ${FLOW_LABEL[m.flow] || FLOW_LABEL.backend}`));
  const head = [`client_id ${m.clientId ?? '-'}`, m.vendor || 'Generic'];
  if (m.flow === 'launch' && m.redirectUri) head.push(`redirect ${m.redirectUri} (${m.redirectMode})`);
  else head.push(`token ${m.tokenUrl ?? '(unknown)'}`);
  lines.push(p.dim(head.join(' · ')));
  lines.push('');
  lines.push(...sectionLines(result.sections, p, sc));

  if (verbose && result.http?.length) {
    lines.push(p.bold(`HTTP exchanges (${result.http.length}) — secrets masked`));
    for (const x of result.http) {
      lines.push(sc(formatExchange(x, p)));
      lines.push('');
    }
  }

  const d = result.diagnosis;
  const texts = VERDICT_TEXT[m.flow] || VERDICT_TEXT.backend;
  const st = { ok: 'pass', warn: 'warn', offline: 'info', fail: 'fail' }[d.verdict] || 'fail';
  lines.push(p.status(st, p.bold(texts[d.verdict] || texts.fail)));
  const causes = d.causes.slice(0, maxCauses);
  if (causes.length) {
    lines.push('');
    lines.push(p.bold(d.verdict === 'fail' ? 'Most likely causes' : 'Things to look at'));
    causes.forEach((c, i) => {
      lines.push(`  ${i + 1}. ${p.bold(c.title)} ${p.dim(`(${confidenceLabel(c.confidence)})`)}`);
      lines.push(`     ${c.why}`);
      if (c.evidence) lines.push(`     ${p.dim('evidence:')} ${sc(c.evidence)}`);
      lines.push(`     ${p.dim('fix:')} ${c.fix}`);
    });
  }
  if (m.thumbprint) {
    lines.push('');
    lines.push(p.dim(`Your public key thumbprint (SHA-256 JWK): ${m.thumbprint}`));
    lines.push(p.dim('Compare it with the key registered in the vendor portal. Use --show-public-jwk to print the public key.'));
  }
  if (showPublicJwk && result.meta.publicJwk) {
    lines.push('');
    lines.push(p.bold('Public JWK (safe to share / publish):'));
    lines.push(JSON.stringify({ keys: [result.meta.publicJwk] }, null, 2));
  }
  if (!verbose && result.http?.length && d.verdict === 'fail') {
    lines.push('');
    lines.push(p.dim('Add --verbose to see every HTTP request and response (secrets masked).'));
  }
  return lines.join('\n');
}

/** Machine-readable JSON (masked). */
export function renderJson(result, { redact = false } = {}) {
  const sc = scrubber(result.meta, redact);
  const text = JSON.stringify(
    {
      tool: 'smart-doctor',
      flow: result.flow || result.meta.flow || 'backend',
      verdict: result.diagnosis.verdict,
      meta: safeMeta(result.meta, redact),
      publicJwk: result.meta.publicJwk,
      sections: result.sections,
      causes: result.diagnosis.causes,
      http: result.http || [],
    },
    null,
    2,
  );
  return sc(text);
}

/** Markdown report that is safe to paste into a support ticket or an AI chat. */
export function renderMarkdown(result, { redact = true, verbose = false } = {}) {
  const m = safeMeta(result.meta, redact);
  const sc = scrubber(result.meta, redact);
  const out = [];
  out.push(`## smart-doctor report — ${FLOW_LABEL[m.flow] || FLOW_LABEL.backend}`);
  out.push('');
  out.push(`- **Verdict:** ${result.diagnosis.verdict}`);
  out.push(`- **Vendor profile:** ${m.vendor || 'Generic'}`);
  out.push(`- **client_id:** \`${m.clientId}\``);
  if (m.auth) out.push(`- **Client authentication:** ${m.auth}`);
  out.push(`- **Token endpoint:** \`${m.tokenUrl ?? 'unknown'}\``);
  if (m.flow === 'launch') out.push(`- **Redirect URI:** \`${m.redirectUri}\` (${m.redirectMode})`);
  if (m.alg || m.kid) out.push(`- **alg / kid:** ${m.alg ?? '-'} / ${m.kid ?? '(none)'}`);
  if (m.thumbprint) out.push(`- **Key thumbprint:** \`${m.thumbprint}\``);
  out.push('');
  out.push('| Step | Check | Result | Detail |');
  out.push('|---|---|---|---|');
  for (const s of result.sections) {
    for (const c of s.checks) {
      out.push(
        `| ${s.name} | ${sc(c.title)} | ${c.status.toUpperCase()} | ${sc(c.detail || '')
          .replace(/\\/g, '\\\\')
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' ')} |`,
      );
    }
  }
  if (result.diagnosis.causes.length) {
    out.push('');
    out.push('### Likely causes');
    result.diagnosis.causes.slice(0, 5).forEach((c, i) => {
      out.push(`${i + 1}. **${c.title}** (${confidenceLabel(c.confidence)}) — ${c.why} _Fix:_ ${c.fix}`);
    });
  }
  if (verbose && result.http?.length) {
    out.push('');
    out.push('<details><summary>HTTP exchanges (secrets masked)</summary>');
    out.push('');
    out.push('```');
    for (const x of result.http) out.push(sc(formatExchange(x)), '');
    out.push('```');
    out.push('</details>');
  }
  out.push('');
  out.push(
    '_No private keys, client secrets, authorization codes, assertions, tokens or patient identifiers are included in this report._',
  );
  return out.join('\n');
}
