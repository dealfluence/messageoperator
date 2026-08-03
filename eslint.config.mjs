import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "bundle/", "node_modules/", ".venv/", "*.mcpb"] },
  {
    files: ["**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      prettier,
    ],
    rules: {
      // strict null policy: no escaping null checks with `!`
      "@typescript-eslint/no-non-null-assertion": "error",
      // mail pipelines strip control chars on purpose; \x00 in regexes is deliberate here
      "no-control-regex": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // tests still get strict null checks from tsc; mocks may cast and assert
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "require-yield": "off",
    },
  },
);
