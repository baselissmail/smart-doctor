// Prompt adapter: how the engine asks a human for text (the paste-back URL,
// wizard answers). The CLI uses readline; the UI uses a form; tests script it.

import readline from 'node:readline/promises';

/**
 * @param {{ input?: NodeJS.ReadStream | NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [opts]
 * @returns {import('../types.js').PromptAdapter}
 */
export function terminalPrompter({ input = process.stdin, output = process.stdout } = {}) {
  let rl;
  const get = () => (rl ||= readline.createInterface({ input, output, terminal: Boolean(/** @type {NodeJS.ReadStream} */ (input).isTTY) }));
  return {
    /** @param {string} question @param {{ defaultValue?: string }} [o] */
    async ask(question, { defaultValue } = {}) {
      const suffix = defaultValue ? ` (${defaultValue})` : '';
      const answer = (await get().question(`${question}${suffix}: `)).trim();
      return answer || defaultValue || '';
    },
    close() {
      rl?.close();
      rl = undefined;
    },
  };
}

/** A prompter that answers from a list (tests, scripted runs). */
export function scriptedPrompter(answers = []) {
  const queue = [...answers];
  return {
    asked: [],
    /** @param {string} question @param {{ defaultValue?: string }} [o] */
    async ask(question, { defaultValue } = {}) {
      this.asked.push(question);
      const next = queue.shift();
      const v = typeof next === 'function' ? await next(question) : next;
      return v === undefined || v === '' ? defaultValue || '' : v;
    },
    close() {},
  };
}
