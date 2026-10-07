import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const typescriptFiles = ['**/*.mts', '**/*.ts'];

export default tseslint.config(
  { ignores: ['build/**', 'coverage/**', 'node_modules/**', 'hnsw-native/target/**'] },
  {
    ...js.configs.recommended,
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { URL: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: typescriptFiles })),
  {
    files: typescriptFiles,
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'guard-for-in': ['warn'],
      '@typescript-eslint/prefer-for-of': ['warn'],
    },
  },
);
