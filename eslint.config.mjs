import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['node_modules/', 'dist/', 'release/', 'data/'] },
  js.configs.recommended,
  {
    files: ['electron/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['scripts/**/*.mjs', '*.mjs', 'tests/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/prop-types': 'off',
    },
  },
  {
    rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] },
  },
];
