import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Components are authored as JSX with the automatic runtime (Next.js handles
  // this at build time); esbuild needs the same setting so render tests can
  // import real .tsx components.
  esbuild: { jsx: "automatic" },
  test: {
    // `.test.tsx` files mount real components in jsdom (the native shell test);
    // everything else runs in the fast node environment.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
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
