// Flat ESLint config — bootstrapped in Week 4 (the repo previously had a root
// `lint` script that recursed into packages defining no lint at all, so the
// gate always exited 0 having linted nothing; AUDIT_REPORT.md Cat 5/CI).
//
// Scope: recommended correctness rules only, no stylistic rules (Prettier-free
// repo). Type-aware linting is deliberately off — tsc --noEmit runs as its own
// CI step and covers that ground faster.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-sourcemap-tmp/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/dev-dist/**',
      'bench/**',
      'terraform/**',
      'test-results/**',
      'playwright-report/**',
      'web/src/components/icons/uswds/**', // generated
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.es2022 },
    },
    rules: {
      // Bootstrap ratchet (documented in CHANGES.md): rules with substantial
      // PRE-EXISTING debt are warnings so the error gate starts at zero and
      // ratchets from here; they are debt to burn down, not license for new
      // violations.
      // - no-explicit-any: ~230 legacy sites, tracked with real numbers by
      //   bench/cat1-types.
      // - no-unused-vars: 114 legacy sites at bootstrap.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The Express Request augmentation (api/src/middleware/auth.ts) uses the
      // standard `declare global { namespace Express }` pattern.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      // Empty catch blocks are an established idiom here for best-effort
      // cleanup paths; the audit tracks silent-failure sites separately.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Bootstrap ratchet: every react-hooks rule (including the v6 React
      // Compiler checks — refs-during-render, purity) reports substantial
      // pre-existing debt (UnifiedEditor conditional-hook cluster, ContextMenu
      // ref reads, Editor.tsx). All warn at bootstrap; real latent issues,
      // logged for dedicated fixes, not license for new ones.
      ...Object.fromEntries(
        Object.keys(reactHooks.configs.recommended.rules).map((k) => [k, 'warn'])
      ),
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Playwright's fixture API requires an object-destructuring first
      // parameter; `async ({}, use)` is its canonical no-deps form.
      'no-empty-pattern': 'off',
    },
  },
  {
    files: ['web/src/components/editor/FileAttachment.tsx'],
    rules: {
      // Pre-existing `this` alias inside a ProseMirror plugin closure; warn at
      // bootstrap, tracked as debt.
      '@typescript-eslint/no-this-alias': 'warn',
    },
  },
  // ── Week 6 public/internal boundary (PlugForge). Added BEFORE any
  // cross-import exists — this decision is far cheaper to enforce than to
  // retrofit (assignment's "one-way door"). Both rules are errors: a
  // violation fails lint, and lint failure fails the CI build.
  {
    // The public platform surface may never import internal route handlers.
    // Public v1 handlers are thin and own their SQL; sharing handler code
    // with /api would let internal semantics leak into the public contract.
    files: ['api/src/platform/**/*.ts'],
    ignores: ['api/src/platform/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/routes/*'],
              message:
                'Public platform code must not import internal route handlers (public/internal boundary, Week 6).',
            },
          ],
        },
      ],
    },
  },
  {
    // External integrations speak to Ship exclusively through the SDK.
    // This is what makes "the agent is a platform citizen" true rather
    // than aspirational.
    files: ['integrations/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/src/**', '@ship/api', '@ship/api/*', '@ship/shared', '@ship/shared/*'],
              message: 'integrations/ may import only @ship/sdk (workspace dependency rule, Week 6).',
            },
          ],
        },
      ],
    },
  }
);
