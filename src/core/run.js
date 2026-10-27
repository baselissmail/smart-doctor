// The engine's spine. A Run is an event stream that every front-end (CLI,
// local UI, CI, tests) can subscribe to — the engine never knows which one is
// listening (ports & adapters). AsyncLocalStorage lets deep modules (the HTTP
// helper) report into the current run without threading it through every call.
//
// Events:
//   step:start  { id, title }
//   step:end    { id, title, status, checks }
//   step:update { id, title, status, checks }   (a finished step gained checks)
//   http        { method, url, request, response, durationMs, ... }  (already redacted)
//   action      { type: 'open-url' | 'await-paste', ... }  (needs the human)
//   log         { level, message }

import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { STATUS } from '../util.js';

const als = new AsyncLocalStorage();

export function currentRun() {
  return als.getStore();
}

export function withRun(run, fn) {
  return als.run(run, fn);
}

/** Overall status of a list of checks (worst wins). */
export function rollup(checks) {
  if (checks.some((c) => c.status === STATUS.FAIL)) return STATUS.FAIL;
  if (checks.some((c) => c.status === STATUS.WARN)) return STATUS.WARN;
  if (checks.some((c) => c.status === STATUS.PASS)) return STATUS.PASS;
  if (checks.some((c) => c.status === STATUS.INFO)) return STATUS.INFO;
  return STATUS.SKIP;
}

export class Run extends EventEmitter {
  constructor({ flow = 'backend' } = {}) {
    super();
    this.id = randomUUID();
    this.flow = flow;
    this.startedAt = new Date().toISOString();
    /** @type {{ id: string, name: string, status: string, checks: any[] }[]} */
    this.steps = [];
    this.exchanges = [];
  }

  /** Open a step; returns a handle with add()/end(). */
  step(id, name) {
    const s = { id, name, status: 'running', checks: [] };
    this.steps.push(s);
    this.emit('step:start', { id, name });
    const run = this;
    return {
      record: s,
      add(...checks) {
        s.checks.push(...checks.flat().filter(Boolean));
        return this;
      },
      end() {
        s.status = rollup(s.checks);
        run.emit('step:end', { ...s });
        return s;
      },
    };
  }

  /** Add checks to a step that already ended (e.g. clock from a later response). */
  amend(id, ...checks) {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return;
    s.checks.push(...checks.flat().filter(Boolean));
    s.status = rollup(s.checks);
    this.emit('step:update', { ...s });
  }

  http(exchange) {
    this.exchanges.push(exchange);
    this.emit('http', exchange);
  }

  action(a) {
    this.emit('action', a);
  }

  log(level, message) {
    this.emit('log', { level, message });
  }

  /** Steps with at least one check, in execution order (what reports show). */
  sections() {
    return this.steps.filter((s) => s.checks.length > 0).map(({ id, name, status, checks }) => ({ id, name, status, checks }));
  }
}
