// The shared end of every flow: diagnose the facts, emit 'done', and shape the result front-ends get.

import { diagnose } from '../diagnose.js';

/** Shared tail for every flow: diagnose, emit, and shape the result. */
export function finish(run, meta, token, facts) {
  const sections = run.sections();
  const diagnosis = diagnose({ checks: sections.flatMap((s) => s.checks), token, vendor: meta.vendor, ...facts });
  const result = {
    runId: run.id,
    flow: run.flow,
    meta,
    sections,
    diagnosis,
    http: run.exchanges,
    tokenRequested: Boolean(token),
    tokenObtained: Boolean(token?.token),
    // In memory only (for the probe / library users). Never rendered unmasked.
    _accessToken: token?.token?.accessToken,
  };
  run.emit('done', publicResult(result));
  return result;
}

/** A result safe to serialise to any front-end. */
export function publicResult(r) {
  const { _accessToken, ...rest } = r;
  return {
    ...rest,
    meta: { ...rest.meta, vendor: rest.meta.vendor ? { id: rest.meta.vendor.id, name: rest.meta.vendor.name } : undefined },
  };
}
