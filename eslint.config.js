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
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/**', 'src/ui/**', 'test/ui/**', '*.config.js']
  }
)
