import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Next.js wires the `server-only` marker itself at build time; the
      // package is not installed, so tests resolve it to an empty shim.
      "server-only": path.resolve(__dirname, "tests/shims/server-only.ts"),
    },
  },
});
