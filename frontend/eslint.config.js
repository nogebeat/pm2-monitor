import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";

/**
 * Config ESLint pour le frontend (Vue 3, ESM, Vite). Le backend a sa
 * propre config à la racine (../eslint.config.js) car il est en CommonJS.
 */
export default [
  js.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "vue/multi-word-component-names": "off",
      "vue/require-default-prop": "off",
      "vue/html-self-closing": "off",
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/html-indent": "off",
      "vue/attributes-order": "off",
      "vue/html-closing-bracket-newline": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "../public/**"],
  },
];
