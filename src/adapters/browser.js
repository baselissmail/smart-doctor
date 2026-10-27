// Browser adapter: how the engine asks a human to open a URL.
// The CLI opens the system browser; the UI asks the page to do it; tests
// use a scripted fake. The engine only ever calls open(url).

import { spawn } from 'node:child_process';

/**
 * @param {{ print?: (url: string) => void }} [opts]  print: show the URL too (the CLI prints it in case no browser opens)
 * @returns {import('../types.js').BrowserAdapter}
 */
export function systemBrowser({ print = () => {} } = {}) {
  return {
    async open(url) {
      print(url);
      if (process.env.SMART_DOCTOR_NO_BROWSER) return;
      const [cmd, args] =
        process.platform === 'darwin'
          ? ['open', [url]]
          : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
            : ['xdg-open', [url]];
      try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
      } catch {
        /* printing the URL is enough */
      }
    },
  };
}
