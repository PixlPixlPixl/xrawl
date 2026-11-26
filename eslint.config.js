// Flat ESLint config for Xrawl.
//
// The point is not stylistic churn: `tsc` already owns types and unused code
// (`noUnusedLocals`). What lint adds is the class of mistakes the compiler
// cannot see - an engine reaching for a DOM global, an `innerHTML` write, a
// stray `console.log` - plus the few style rules this codebase follows.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Layers that must stay host-agnostic by contract.
 *
 * `src/world` is deliberately absent: perception is *allowed* to know the DOM
 * (see the layer table in README.md). The creature engine, the scoring layer
 * and the semantic layer are the ones a desktop host must be able to reuse
 * unchanged, and test/architecture.test.ts guards their imports.
 */
const HOST_AGNOSTIC_LAYERS = ['src/creature/**', 'src/progression/**', 'src/semantics/**'];

/** Browser globals a host-agnostic layer must reach through a port instead. */
const FORBIDDEN_IN_ENGINES = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'IDBKeyRange',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'fetch',
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.wxt/**',
      '.output/**',
      'src/public/**',
      'test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, ...globals.node },
    },
    rules: {
      // The codebase uses `!` where a guard already proved the value exists
      // (Dexie rows, index access). tsc owns unused code.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      // `console.warn`/`error` are the only logging this extension does.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'properties'],
    },
  },
  {
    // Host-agnostic layers: a browser global here is a layering bug, not a typo.
    files: HOST_AGNOSTIC_LAYERS,
    rules: {
      'no-restricted-globals': [
        'error',
        ...FORBIDDEN_IN_ENGINES.map((name) => ({
          name,
          message: `${name} is not available in this layer; take it through a platform port.`,
        })),
      ],
    },
  },
  {
    // Every UI surface builds nodes with textContent. Page titles, words and
    // sentences end up in the journal; parsing them as HTML would let a page
    // run script inside an extension page.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
          message: 'Build nodes with textContent: page text must never be parsed as HTML.',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'Build nodes with textContent: page text must never be parsed as HTML.',
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'Dynamic code evaluation is forbidden by the extension CSP.',
        },
        {
          selector: "CallExpression[callee.name='eval']",
          message: 'Dynamic code evaluation is forbidden by the extension CSP.',
        },
      ],
    },
  },
  {
    // Scripts and the e2e harness are Node programs that print progress.
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', '*.config.js', 'eslint.config.js'],
    rules: { 'no-console': 'off' },
  },
);
