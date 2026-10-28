// Property-based tests (fuzzing): thousands of generated inputs instead of hand-picked examples,
// for the code that handles whatever a server or a user throws at it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { explainError, normalizeError, scopeSyntax } from '../src/diagnose.js';
import { CAUSES } from '../src/knowledge/causes.js';
import { redactText } from '../src/core/redact.js';
import { parseCallback } from '../src/launch.js';

const RUNS = { numRuns: 300 };
const secretLike = fc.stringMatching(/^[A-Za-z0-9_-]{6,48}$/);
const b64url = (min) => fc.stringMatching(new RegExp(`^[A-Za-z0-9_-]{${min},40}$`));

test('explain never throws and only ranks causes that exist', () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.json(), fc.string({ unit: 'binary' })), (text) => {
      const d = explainError(text);
      assert.ok(Array.isArray(d.causes));
      for (const c of d.causes) {
        assert.ok(CAUSES[c.id], `unknown cause ${c.id}`);
        assert.ok(c.confidence >= 0 && c.confidence <= 1);
      }
    }),
    RUNS,
  );
});

test('server error text never shows a secret the request carried, wherever it appears', () => {
  fc.assert(
    fc.property(fc.string(), secretLike, fc.string(), (before, secret, after) => {
      const out = redactText(`${before}${secret}${after}`, [secret]) || '';
      assert.ok(!out.includes(secret), `secret survived: ${JSON.stringify(out)}`);
    }),
    RUNS,
  );
});

test('anything shaped like a JWT in server text is masked', () => {
  fc.assert(
    fc.property(fc.string(), b64url(6), b64url(6), b64url(0), fc.string(), (before, header, payload, sig, after) => {
      const jwt = `eyJ${header}.${payload}.${sig}`;
      const out = redactText(`${before} ${jwt} ${after}`) || '';
      assert.ok(!out.includes(jwt), `JWT survived: ${JSON.stringify(out)}`);
    }),
    RUNS,
  );
});

test('pasted callback URLs never crash the parser', () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.webUrl({ withQueryParameters: true, withFragments: true })), (text) => {
      const r = parseCallback(text, 'https://app.example.com/callback');
      assert.equal(typeof r, 'object');
    }),
    RUNS,
  );
});

test('error-code normalisation is stable', () => {
  fc.assert(
    fc.property(fc.string(), (code) => {
      const once = normalizeError(code);
      assert.equal(normalizeError(once), once);
    }),
    RUNS,
  );
});

test('scope parsing never throws', () => {
  fc.assert(
    fc.property(fc.string(), (scope) => {
      const r = scopeSyntax(scope);
      assert.equal(typeof r.usesV1, 'boolean');
      assert.equal(typeof r.usesV2, 'boolean');
    }),
    RUNS,
  );
});
