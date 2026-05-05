import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "eslint.config.mjs",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "packages/ui/lib/features/extensions/iframeBootstrap.inline.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/exhaustive-deps": ["warn", {
        additionalHooks: "(useLatestRef)",
      }],
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: [
      "packages/ui/lib/components/PanelGroup/**",
      "packages/ui/lib/features/**",
      "packages/ui/lib/dialogs/**",
      "packages/ui/lib/hooks/**",
    ],
    rules: {
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    files: ["eslint.config.mjs", "vite.config.ts", "packages/*/vite.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
