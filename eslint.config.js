import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.lint.json',
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    // The webapp has its own tsconfig, so it needs its own parser project.
    // Without this block src/ui is unlinted and `any` goes unenforced there:
    // tsc --strict catches only implicit any.
    files: ['src/ui/**/*.ts', 'test/ui/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './src/ui/tsconfig.json',
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      eqeqeq: ['error', 'always'],
      'no-return-assign': ['error', 'always'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-inferrable-types': 'off'
    }
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/**', '*.config.js']
  }
)
