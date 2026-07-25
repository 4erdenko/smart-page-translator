import eslint from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [".my_local_dev/**", "artifacts/**", "dist/**", "node_modules/**"]
  },
  eslint.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.webextensions
      },
      sourceType: "script"
    }
  },
  {
    files: ["src/lib/**/*.js"],
    languageOptions: {
      globals: {
        module: "readonly"
      }
    }
  },
  {
    files: ["src/service-worker.js"],
    languageOptions: {
      globals: {
        importScripts: "readonly"
      }
    }
  },
  {
    files: ["src/pdf/pdf.js"],
    languageOptions: {
      sourceType: "module"
    }
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module"
    }
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "commonjs"
    }
  }
];
