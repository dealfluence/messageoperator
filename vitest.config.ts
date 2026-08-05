import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // pins the secret backend to files: no test may touch the host keychain
    setupFiles: ["./test/setup.ts"],
    // broker cycles do real filesystem work in temp dirs; give slow CI headroom
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
