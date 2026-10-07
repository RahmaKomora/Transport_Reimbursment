import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * What `npm run lint` checks, and what the Lint & Test job runs on every pull request.
 *
 * Deliberately the recommended sets and little else: the point is to catch real mistakes —
 * an undefined name, a hook called conditionally, a variable that was meant to be used —
 * not to restyle a codebase that already reads consistently.
 */
export default [
  { ignores: ['dist/', 'dist-artifact/', 'node_modules/', 'server/data/', 'server/uploads/', 'server/reports/', 'test-results/'] },

  js.configs.recommended,

  {
    files: ['server/**/*.js', '*.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },

  // Browser tests run in Node but hand functions to page.evaluate, which run in the page.
  {
    files: ['e2e/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },

  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      // Without these, a component used only in JSX reads as an unused import.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    rules: {
      // A leading underscore marks a parameter that is there for its position, like
      // Express's (_req, res).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // `catch {}` with a comment is how this codebase says "deliberately ignored".
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
