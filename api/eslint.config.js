import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    files: ['test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/ban-ts-comment': 'off' },
  },
);
