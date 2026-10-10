import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // .claude: a local working folder (see .gitignore).
  // prof-*: throw-away browser profiles of ad-hoc headless probes (see .gitignore).
  // design-template: the generated pages of the interface (see .gitignore).
  globalIgnores(['dist', 'release', 'coverage', '.claude', 'prof-*', 'design-template']),
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
            {
              group: ['**/design', '**/design/*'],
              message: 'The viewer must not depend on src/design.',
            },
          ],
        },
      ],
    },
  },
  {
    // The rest of the viewer: src/design renders it into static pages and is not bundled with it.
    // A block of its own: a later block that sets the same rule for the same file replaces the
    // earlier options, so one block over all of src would switch off the rules of src/core above.
    files: ['src/ui/**/*.{ts,tsx}', 'src/providers/**/*.ts', 'src/main.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/design', '**/design/*'],
              message: 'The viewer must not depend on src/design.',
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
