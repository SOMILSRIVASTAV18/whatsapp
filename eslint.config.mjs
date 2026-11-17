import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'node_modules/**/*', 'render/**/*']
  },
  firebaseRulesPlugin.configs['flat/recommended']
];
