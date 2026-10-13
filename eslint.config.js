export default [
  {
    // lib/*.js and web/gravityport/dist are build outputs rebuilt by npm
    // lifecycle scripts (see .gitignore); linting generated bundles flags
    // emitted code, not authored code.
    ignores: ["node_modules/", "**/node_modules/", "coverage/", "out/", "desktop/out/", "assets/", "production/", "canvas/", "outputs/", "web/gravityport/dist/", "lib/*.js", "lib/*.js.map", "lib/*.d.ts", "!lib/sqlite-asset-store.d.ts"],
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-debugger": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "valid-typeof": "error",
    },
  },
];
