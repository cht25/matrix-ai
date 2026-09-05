import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// =============================================================================
// Contextual UI contract (product spec §28, §23, §12, §13)
//
// The clutter fix must be structural: capabilities are mounted only when they
// are relevant. These tests read the real sources so a regression that
// re-renders "everything everywhere" (or hides it with CSS) fails the build.
// =============================================================================

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const chatClient = () => read("src/components/chat-client.tsx");
const assistantMessage = () => read("src/components/assistant-message.tsx");
const topBar = () => read("src/components/chat-topbar.tsx");
const agentCard = () => read("src/components/agent-sandbox.tsx");
const activityPanel = () => read("src/components/activity-panel.tsx");
const modeTools = () => read("src/components/mode-workspace.tsx");
const globalCss = () => read("src/app/globals.css");

describe("always-on feature panels are gone", () => {
  it("removed the unconditional export desk, thinking block and raw console", () => {
    expect(existsSync(join(root, "src/components/export-desk.tsx"))).toBe(false);
    expect(existsSync(join(root, "src/components/thinking-indicator.tsx"))).toBe(false);
    expect(existsSync(join(root, "src/components/execution-console.tsx"))).toBe(false);
    const source = chatClient();
    expect(source).not.toMatch(/ExportDesk/);
    expect(source).not.toMatch(/ThinkingIndicator|ThinkingSummary/);
    expect(source).not.toMatch(/ExecutionConsole/);
  });

  it("does not hide features with CSS — the panels are simply not rendered", () => {
    const css = globalCss();
    // No blanket "hide the clutter" rules for the chat feature panels.
    expect(css).not.toMatch(/\.(export-desk|agent-sandbox|thinking-block|exec-console)\s*{[^}]*display:\s*none/);
    expect(css).not.toMatch(/\.thinking-/);
    const source = assistantMessage();
    expect(source).not.toMatch(/className="[^"]*\bhidden\b[^"]*"[^>]*>\s*<(ExportDesk|ArtifactCard|AgentActivityCard)/);
  });

  it("no longer ships a simulated reasoning trace", () => {
    const source = chatClient() + assistantMessage() + activityPanel();
    expect(source).not.toMatch(/Thinking it through|Reading your message|Agent reasoning|chain[- ]of[- ]thought/i);
  });
});

describe("rendering is intent-driven", () => {
  it("detects intent before choosing a capability", () => {
    const source = chatClient();
    expect(source).toMatch(/detectIntent\(/);
    expect(source).toMatch(/selectCapability\(/);
    expect(source).toMatch(/effectiveMode\(/);
    expect(source).toMatch(/action: isImage \? "image" : isOrchestrator \? "orchestrate" : "chat"/);
  });

  it("renders artifacts only from a real artifact state", () => {
    const source = assistantMessage();
    expect(source).toMatch(/isArtifactVisible\(artifact\)/);
    expect(source).toMatch(/showArtifact \? \(/);
    // A format choice only appears for an ambiguous document request.
    expect(source).toMatch(/intent\.needsFormatChoice/);
    // Execution detail only when a run really happened and finished.
    expect(source).toMatch(/execution\.status !== "idle"/);
    // Flashcards only when the reply actually contains them.
    expect(source).toMatch(/signals\.hasFlashcards/);
  });

  it("plans contextual actions instead of listing every action", () => {
    const source = chatClient();
    expect(source).toMatch(/planResponseActions\(/);
    expect(source).toMatch(/availableExportFormats\(/);
    expect(source).toMatch(/classifyResponseKind\(/);
    expect(source).toMatch(/canExport: !intent\.suppressExport/);
  });

  it("keeps plain chat free of execution and analytics state", () => {
    const source = chatClient();
    expect(source).toMatch(/const trackExecution = isAgentRun \|\| isImage \|\| isOrchestrator \|\| demoMode;/);
    expect(source).toMatch(/trackExecution && data\.analytics/);
  });

  it("exports are behind the More menu unless explicitly requested", () => {
    const source = chatClient();
    // Export is an overflow action; the inline row opens only on demand.
    expect(source).toMatch(/export: \(\) => setExportPickerKey/);
    expect(source).toMatch(/exportPickerOpen=\{exportPickerKey === key && !intent\.suppressExport\}/);
  });
});

describe("progressive disclosure defaults to closed", () => {
  it("agent execution collapses when the task finishes", () => {
    const source = agentCard();
    expect(source).toMatch(/useState\(running\)/);
    expect(source).toMatch(/setOpen\(execution\.status === "running"\)/);
    expect(source).toMatch(/Agent task completed/);
    expect(source).toMatch(/if \(execution\.status === "idle"\) return null;/);
  });

  it("activity and performance start closed", () => {
    const source = activityPanel();
    expect(source).toMatch(/const \[open, setOpen\] = useState\(false\);/g);
    expect((source.match(/useState\(false\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/if \(!hasExecutionDetail\(execution\)\) return null;/);
    expect(source).toMatch(/if \(!execution\.analytics\) return null;/);
  });

  it("mode tools render only when they are relevant", () => {
    const source = modeTools();
    expect(source).toMatch(/if \(!hasConversation\) return \[\];/);
    expect(source).toMatch(/if \(!visible\.length && !hidden\.length && !showWorkspace && mode !== "study"\) return null;/);
    expect(source).toMatch(/signals\?\.hasSources/);
  });

  it("flashcards stay folded until opened", () => {
    const source = modeTools();
    expect(source).toMatch(/if \(!cards\.length\) return null;/);
    expect(source).toMatch(/const \[open, setOpen\] = useState\(false\);/);
  });
});

describe("clean top bar", () => {
  it("keeps two primary selects and moves the rest into Settings", () => {
    const source = topBar();
    expect((source.match(/<select/g) ?? []).length).toBe(2);
    expect(source).toMatch(/Chat settings/);
    expect(source).toMatch(/Response strategy/);
    expect(source).toMatch(/Demo mode/);
    // Strategy/demo are menu items, not permanent inline controls.
    expect(source).not.toMatch(/aria-label="Response strategy"/);
    expect(source).toMatch(/● |Ready/);
  });

  it("the chat client no longer renders the old control wall", () => {
    const source = chatClient();
    expect(source).not.toMatch(/Agent Mode Active/);
    expect(source).not.toMatch(/Image Generation Active/);
    expect(source).not.toMatch(/Sandbox Active/);
    expect(source).not.toMatch(/>\s*Demo\s*</);
    expect(source).toMatch(/<ChatTopBar/);
  });
});

describe("artifacts are built for real", () => {
  it("the client builds files through the shared exporter", () => {
    const source = chatClient();
    expect(source).toMatch(/buildArtifact\(format, content, title\)/);
    expect(source).toMatch(/URL\.createObjectURL/);
    expect(source).toMatch(/anchor\.download = built\.filename/);
    // Open is offered only for formats a browser can render.
    expect(source).toMatch(/const OPENABLE: ExportFormat\[\] = \["pdf", "markdown", "txt", "json", "csv"\]/);
  });
});
