import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
        "@typescript-eslint/no-unused-vars": ["warn", {
            argsIgnorePattern: "^_",
            destructuredArrayIgnorePattern: "^_",
        }],
        "eqeqeq": ["error", "always"],
        "guard-for-in": ["warn"],
        "@typescript-eslint/prefer-for-of": ["warn"],
    },
  },
);