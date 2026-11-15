// ESLint flat config. Aimed at real defects (undefined names, unused code, unhandled promises,
// hook rules, switch fall-through …), not at style: formatting is Prettier's job
// (eslint-config-prettier switches off anything that could fight it). Run with `npm run lint`.
import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const unused = [
  'error',
  { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
];

// Additions to eslint:recommended that catch mistakes rather than enforce a style.
const defects = {
  'no-self-compare': 'error',
  'no-template-curly-in-string': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unreachable-loop': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-irregular-whitespace': ['error', { skipStrings: true, skipRegExps: true, skipTemplates: true }], // e.g. stripping a BOM
};

// Recommended rules switched off because they are about style or habit and only fire on deliberate code here.
const notDefects = {
  'no-useless-escape': 'off', // `\[` inside character classes etc.: harmless
  'no-useless-assignment': 'off', // defensive `let x = null;` before try/if – all current hits are harmless
  'preserve-caught-error': 'off', // rethrowing with a user-facing message is intentional
  'no-control-regex': 'off', // input validation deliberately matches control characters (/[\u0000-\u001f]/)
};

// Rules that need type information (tsconfig.json for server/ and shared/, web/tsconfig.json for web/src).
const typed = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
};

export default defineConfig(
  globalIgnores(['**/node_modules/', '**/dist/', 'web/dev-dist/', 'data/', 'docs/', 'coverage/']),

  // ---- plain JavaScript: server, shared code, tests, scripts
  {
    files: ['server/**/*.js', 'shared/**/*.js', 'tests/**/*.mjs', 'scripts/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser, // for the type-aware rules; the files stay plain JavaScript
      parserOptions: {
        projectService: { allowDefaultProject: ['tests/*.mjs', 'scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { ...defects, ...notDefects, ...typed, 'no-unused-vars': unused },
  },
  {
    // shared/ also runs in the browser (bundled into web/)
    files: ['shared/**/*.js'],
    languageOptions: { globals: { ...globals['shared-node-browser'] } },
  },
  {
    // tests and the UX audit drive a browser: callbacks passed to page.evaluate() run there (axe is injected)
    files: ['scripts/*.mjs', 'tests/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, axe: 'readonly' } },
  },

  // ---- web app (TypeScript + React)
  {
    files: ['web/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser },
    },
    rules: {
      ...defects,
      ...notDefects,
      ...typed,
      // The store fires persist()/sync() and react-router's navigate() without awaiting them on purpose
      // (70 hits, most in store/core.ts). Turn this on once those calls are marked with `void` or handled.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-vars': unused,
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      '@typescript-eslint/no-explicit-any': 'off', // `any` is used deliberately at API boundaries (242 hits)
      'prefer-const': 'off', // style
      // React Compiler readiness checks (the app does not use the compiler); they flag patterns that work today:
      // setState at the start of an effect (8), non-trivial useMemo dependency lists (2), refs read during render (2),
      // Date.now() during render for "x minutes ago" labels (7).
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/use-memo': 'off',
      'react-hooks/refs': 'off',
    },
  },

  prettier,
);
