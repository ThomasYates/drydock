/*
 * One flat config for both halves of the repo. The server is Node ESM, the web
 * client is browser ESM with JSX; the rules that matter are the same either
 * way, so only the environment and the React plugins differ.
 */
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

const shared = {
  'no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',
  }],
  // an empty catch is how this codebase says "best effort, carry on"
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'prefer-const': 'error',
  'no-var': 'error',
  'object-shorthand': ['error', 'properties'],
  'no-console': 'off',
  'no-await-in-loop': 'off',
  'no-continue': 'off',
  'no-plusplus': 'off',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'server/public/**',
      'data/**',
    ],
  },

  js.configs.recommended,

  {
    name: 'drydock/server',
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: shared,
  },

  {
    name: 'drydock/web',
    files: ['web/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // injected by vite.config.js at build time
        __APP_VERSION__: 'readonly',
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...shared,
      ...reactHooks.configs.recommended.rules,
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-vars': 'error',
      'react/prop-types': 'off',
    },
  },

  {
    name: 'drydock/config',
    files: ['*.config.js', 'web/vite.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: shared,
  },
];
