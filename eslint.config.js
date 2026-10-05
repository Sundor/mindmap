import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // .claude: a local working folder (see .gitignore).
  // prof-*: throw-away browser profiles of ad-hoc headless probes (see .gitignore).
  globalIgnores(['dist', 'release', 'coverage', '.claude', 'prof-*']),
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    // Browser app
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    // Pure core: no UI frameworks, no reaching into UI/providers.
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*', '@xyflow/*', 'zustand'],
              message: 'src/core must stay free of React/UI libraries.',
            },
            {
              group: ['**/ui', '**/ui/*', '**/providers', '**/providers/*'],
              message: 'src/core must not depend on UI or providers.',
            },
          ],
        },
      ],
    },
  },
  {
    // Node-side tooling
    files: ['*.{js,ts}', 'scripts/**/*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
  },
]);
