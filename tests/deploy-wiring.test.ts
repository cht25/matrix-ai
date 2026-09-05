// =============================================================================
// Wiring + honesty guards (§32, §39, §40)
//
// These read the real source, because the important property of this feature is
// not "a function returns the right string" — it is that no screen is allowed
// to invent a build, a deployment or a URL. A grep that pins those boundaries
// catches the regressions a unit test cannot.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

const CHAT = read("src/components/chat-client.tsx");
const ASSISTANT = read("src/components/assistant-message.tsx");
const WORKSPACE = read("src/components/projects/project-workspace.tsx");
const DEPLOY_FACADE = read("src/lib/server/deploy.ts");
const PROVIDER = read("src/lib/deploy/provider.ts");
const FIRESTORE_PROVIDER = read("src/lib/deploy/firestore-provider.ts");
const POPUP = read("src/components/build/deploy-card.tsx");
const PANEL = read("src/components/build/deployment-panel.tsx");
const BUILD_ROUTE = read("src/app/api/build/route.ts");

describe("chat routes build requests through the real pipeline", () => {
  it("classifies intent before asking the model", () => {
    expect(CHAT).toContain("detectBuildIntent(");
    expect(CHAT).toContain("shouldRunBuildPipeline(");
    expect(CHAT.indexOf("detectBuildIntent(")).toBeLessThan(CHAT.indexOf("await streamMessage(message, { attachments: pending"));
  });

  it("runs the pipeline instead of the plain chat path", () => {
    expect(CHAT).toContain("streamBuildRun(");
    expect(CHAT).toContain("runBuildTurn(message, buildIntent, turnId, pending)");
    expect(CHAT).toContain("<BuildStatusCard run={buildRun} />");
  });

  it("asks a clarification rather than deploying a guess", () => {
    expect(CHAT).toContain("buildIntent.needsClarification");
    expect(CHAT).toContain("buildIntent.clarification");
  });

  it("shows the deployment row from stored message metadata", () => {
    expect(ASSISTANT).toContain("<BuildRunCard");
    expect(ASSISTANT).toContain("message.metadata?.build");
  });

  it("only celebrates when the provider reported a live deployment", () => {
    expect(CHAT).toContain('run?.deployment?.status === "live"');
    expect(POPUP).toContain('run.status !== "succeeded"');
    expect(POPUP).toContain("if (!url) return null");
  });

  it("carries no self-invented publish flag", () => {
    expect(CHAT).not.toMatch(/published\s*=\s*true/);
    expect(CHAT).not.toMatch(/setPublished\(true\)/);
    expect(WORKSPACE).not.toMatch(/setPublished\(true\)/);
  });
});

describe("hosting stays behind the provider abstraction", () => {
  it("the server facade delegates instead of writing the site itself", () => {
    expect(DEPLOY_FACADE).toContain("new FirestoreDeploymentProvider(");
    // Only the provider may flip a site to live; the facade can take it down.
    expect(DEPLOY_FACADE).not.toMatch(/status:\s*"live"/);
  });

  it("an unconfigured host fails loudly instead of faking success", () => {
    expect(PROVIDER).toContain("class UnconfiguredDeploymentProvider");
    expect(PROVIDER).toContain("HOSTING_NOT_CONFIGURED");
    expect(FIRESTORE_PROVIDER).toContain("export class FirestoreDeploymentProvider");
    expect(FIRESTORE_PROVIDER).toContain("export function createProvider");
  });

  it("capabilities, not wishful thinking, decide what the UI offers", () => {
    expect(PANEL).toContain("capabilities?.rollback");
    expect(PANEL).toContain("supportedEnvironments(");
    expect(PANEL).toContain("rollback_available");
  });
});

describe("the build API is the only writer of run state", () => {
  it("streams the run and reconciles on reload", () => {
    expect(BUILD_ROUTE).toContain('type: "run"');
    expect(BUILD_ROUTE).toContain("runBuildPipeline(");
    expect(BUILD_ROUTE).toContain("latestBuildRunForProject");
    expect(BUILD_ROUTE).toContain("readBuildRun(");
  });

  it("refuses more than a bounded number of concurrent runs per user", () => {
    expect(BUILD_ROUTE).toContain("BUILD_RATE_LIMITED");
    expect(BUILD_ROUTE).toContain("assertCapacity");
  });

  it("never accepts a URL from the browser", () => {
    expect(BUILD_ROUTE).not.toContain("body.url");
    expect(BUILD_ROUTE).not.toMatch(/deployment_url/);
  });
});

describe("client components never import server-only code", () => {
  for (const file of [
    "src/components/build/build-progress.tsx",
    "src/components/build/deploy-card.tsx",
    "src/components/build/deployment-panel.tsx",
    "src/components/build/deployment-manage.tsx",
    "src/components/build/build-run-card.tsx",
    "src/components/chat-client.tsx",
  ]) {
    it(`${file} imports only shared view models`, () => {
      expect(read(file)).not.toContain("@/lib/server/");
    });
  }
});

describe("styling stays inside the Matrix tokens", () => {
  it("uses the design system palette instead of new colours", () => {
    const styles = [POPUP, PANEL, read("src/components/build/build-progress.tsx"), read("src/components/build/deployment-manage.tsx")].join("\n");
    expect(styles).not.toMatch(/#[0-9a-f]{6}/i);
    expect(styles).not.toMatch(/\b(?:bg|text|border)-(?:red|green|blue|yellow|purple|pink)-(?:400|500|600)\b/);
  });
});
