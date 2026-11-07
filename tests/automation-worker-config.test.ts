import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const script = path.resolve(process.cwd(), "scripts/automation-worker.mjs");
const secret = "a".repeat(48);

function runWorker(env: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, ...env },
  });
}

describe("automation worker target configuration", () => {
  it("refuses to start without an explicit application target", () => {
    const result = runWorker({ AUTOMATION_WORKER_SECRET: secret, MATRIX_WORKER_TARGET_URL: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MATRIX_WORKER_TARGET_URL must be set");
  });

  it("refuses localhost HTTP targets outside development", () => {
    const result = runWorker({
      NODE_ENV: "production",
      AUTOMATION_WORKER_SECRET: secret,
      MATRIX_WORKER_TARGET_URL: "http://127.0.0.1:3000",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a valid HTTPS origin");
  });

  it("rejects private address targets even when they use HTTPS", () => {
    const result = runWorker({
      NODE_ENV: "production",
      AUTOMATION_WORKER_SECRET: secret,
      MATRIX_WORKER_TARGET_URL: "https://192.168.1.5",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a valid HTTPS origin");
  });

  it("rejects URL credentials and query parameters", () => {
    for (const target of ["https://user:password@matrix.example", "https://matrix.example/?token=secret"]) {
      const result = runWorker({
        NODE_ENV: "production",
        AUTOMATION_WORKER_SECRET: secret,
        MATRIX_WORKER_TARGET_URL: target,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be a valid HTTPS origin");
    }
  });
});
