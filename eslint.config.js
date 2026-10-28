// Lint rules: ESLint's recommended set plus a few that catch real bugs. Formatting is Prettier's job.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'dist/', 'site/dist/', 'screenshots/', '.smart-doctor/'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-var': 'error',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // The local web UI's page script and the Playwright smoke script's page callbacks run in the browser.
    files: ['src/ui/**/*.js', 'scripts/ui-smoke.mjs', 'scripts/readme-images.mjs', 'site/assets/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
