'use strict';

const nodeGlobals = Object.fromEntries(
  [
    'require', 'module', 'exports', '__dirname', '__filename', 'process', 'console', 'Buffer',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
    'queueMicrotask', 'structuredClone', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
    'AbortController', 'AbortSignal', 'fetch',
  ].map((name) => [name, 'readonly']),
);

module.exports = [
  { ignores: ['node_modules/', 'coverage/', '.claude/skills/'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: nodeGlobals },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
];
