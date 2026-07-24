import eslint from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["artifacts/**", "dist/**", "node_modules/**"]
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
