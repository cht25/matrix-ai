// Test shim: Next.js aliases the `server-only` marker package internally at
// build time, so it is intentionally not a runtime dependency. Vitest needs a
// resolvable target instead — this empty module plays that role.
export {};
