"use strict";

const js = require("@eslint/js");
const globals = require("globals");
const prettierConfig = require("eslint-config-prettier");

/**
 * Config ESLint pour le backend (Node.js, CommonJS). Le frontend a sa
 * propre config (frontend/eslint.config.js) car il est en ESM + Vue.
 *
 * Volontairement peu strict sur le style (Prettier s'en charge via
 * eslint-config-prettier) : on vérifie surtout les erreurs probables
 * (variables inutilisées, code inatteignable...), pas des préférences
 * esthétiques.
 */
module.exports = [
  {
    ignores: ["frontend/**", "public/**", "node_modules/**", "data/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-console": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
      },
    },
  },
  prettierConfig,
];
