import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ChatClient uses the App Router; a static render only needs the hook stubbed.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { ChatClient } from "../src/components/chat-client";
import type { ChatMessage } from "../src/lib/chat-messages";

// =============================================================================
// Rendered-output contract (product spec §32 test cases)
//
// These render the REAL component tree and assert what a user actually sees:
// a clean conversation by default, and each capability only when its intent or
// content makes it relevant. Effects do not run during a static render, so the
// assertions below describe the first paint — exactly what "clean by default"
// means.
// =============================================================================

function render(messages: ChatMessage[], mode: "general" | "study" | "code" | "agent" | "image" = "general") {
  return renderToStaticMarkup(
    createElement(ChatClient, {
      initialMessages: messages,
      conversationId: null,
      isTemporary: false,
      initialMode: mode,
    }),
  );
}

const at = (offset = 0) => new Date(Date.now() - offset).toISOString();

describe("test 1 & 8 — a clean conversation renders nothing else", () => {
  const html = render([
    { role: "user", content: "hi", created_at: at(60_000) },
    { role: "assistant", content: "Hello! How can I help you?", created_at: at(30_000), metadata: { mode: "general" } },
  ]);

  it("shows the exchange and the three contextual actions", () => {
    expect(html).toContain("hi");
    expect(html).toContain("Hello! How can I help you?");
    expect(html).toContain("Copy");
    expect(html).toContain("Regenerate");
    expect(html).toContain("More");
  });

  it("shows no export panel", () => {
    expect(html).not.toContain("Export as");
    expect(html).not.toContain("Generate PDF");
    expect(html).not.toMatch(/>DOCX</);
    expect(html).not.toMatch(/>CSV</);
    expect(html).not.toMatch(/>JSON</);
    expect(html).not.toMatch(/>TXT</);
  });

  it("shows no agent sandbox, analytics or thinking panel", () => {
    expect(html).not.toContain("Agent sandbox");
    expect(html).not.toContain("Agent execution");
    expect(html).not.toContain("Pipeline performance");
    expect(html).not.toContain("Tokens/sec");
    expect(html).not.toContain("Thinking");
    expect(html).not.toContain("Thought for");
    expect(html).not.toContain("Activity");
  });

  it("keeps the top bar to mode, model, status and settings", () => {
    expect(html).toContain("Matrix mode");
    expect(html).toContain("Ready");
    expect(html).toContain("Chat settings");
    expect(html).not.toContain("Agent Mode Active");
    expect(html).not.toContain("Sandbox Active");
    // Strategy and demo live inside Settings, not as permanent controls.
    expect(html).not.toContain(">Demo<");
    expect(html).not.toContain("Response strategy");
  });

  it("renders an empty conversation with no artifact surfaces at all", () => {
    const empty = render([]);
    expect(empty).toContain("How can I help today?");
    expect(empty).not.toContain("Export");
    expect(empty).not.toContain("Agent execution");
    expect(empty).not.toContain("Performance");
  });
});

describe("test 2 — an explanatory answer stays a plain answer", () => {
  const html = render([
    { role: "user", content: "Explain photosynthesis.", created_at: at() },
    {
      role: "assistant",
      created_at: at(),
      content: "Photosynthesis converts light into chemical energy.\n\n- Chlorophyll absorbs light\n- Water and CO2 become glucose\n- Oxygen is released",
      metadata: { mode: "general", intent: "CHAT", artifact_type: "NONE" },
    },
  ]);

  it("offers only chat actions", () => {
    expect(html).toContain("Copy");
    expect(html).toContain("Regenerate");
    expect(html).not.toContain("Run");
    expect(html).not.toContain("Copy code");
    expect(html).not.toContain("Sources");
    expect(html).not.toContain("Export as");
    expect(html).not.toContain("CSV");
  });
});

describe("test 3 — an explicit PDF request renders only the PDF workflow", () => {
  const html = render([
    { role: "user", content: "Explain photosynthesis.", created_at: at() },
    { role: "assistant", content: "Photosynthesis converts light into chemical energy.", created_at: at() },
    { role: "user", content: "Turn this answer into a PDF.", created_at: at(), metadata: { intent: "EXPORT", artifact_type: "PDF" } },
    {
      role: "assistant",
      content: "Sure — your PDF is ready.",
      created_at: at(),
      metadata: {
        intent: "EXPORT",
        artifact_type: "PDF",
        artifact: { requested: true, type: "PDF", status: "ready", format: "pdf", filename: "photosynthesis.pdf", title: "Photosynthesis" },
      },
    },
  ]);

  it("shows the ready artifact with Open and Save", () => {
    expect(html).toContain("PDF ready");
    expect(html).toContain("Open");
    expect(html).toContain("Save");
    expect(html).toContain("photosynthesis.pdf");
  });

  it("does not offer unrelated formats", () => {
    expect(html).not.toContain("Export as");
    expect(html).not.toContain("Generate DOCX");
    expect(html).not.toMatch(/>CSV</);
    expect(html).not.toMatch(/>JSON</);
  });
});

describe("test 4 — a CSV request on tabular data", () => {
  const html = render([
    { role: "user", content: "Create a CSV from this table.", created_at: at(), metadata: { intent: "EXPORT", artifact_type: "CSV" } },
    {
      role: "assistant",
      content: "Here is the data:\n\n| id | name |\n| --- | --- |\n| 1 | Ada |\n| 2 | Grace |",
      created_at: at(),
      metadata: {
        intent: "EXPORT",
        artifact_type: "CSV",
        artifact: { requested: true, type: "CSV", status: "requested", format: "csv", filename: "users.csv", title: "Users" },
      },
    },
  ]);

  it("offers to generate the CSV and nothing else", () => {
    expect(html).toContain("CSV requested");
    expect(html).toContain("Generate CSV");
    expect(html).not.toContain("Generate PDF");
    expect(html).not.toContain("Agent execution");
  });
});

describe("test 5 — an image reply exposes image actions only", () => {
  const html = render([
    { role: "user", content: "Generate an image of a futuristic Matrix city.", created_at: at(), metadata: { intent: "IMAGE_GENERATION", artifact_type: "IMAGE" } },
    {
      role: "assistant",
      content: "Image ready.",
      created_at: at(),
      metadata: {
        mode: "image",
        intent: "IMAGE_GENERATION",
        artifact_type: "IMAGE",
        provider: "Together",
        image_data_url: "data:image/png;base64,iVBORw0KGgo=",
        artifact: { requested: true, type: "IMAGE", status: "ready", format: null, filename: "matrix-image.png", title: "Matrix image" },
      },
    },
  ]);

  it("renders the image and its own action set", () => {
    expect(html).toContain("Generated image");
    expect(html).toContain("Image ready");
    expect(html).toContain("Edit prompt");
    expect(html).toContain("Save");
    expect(html).not.toContain("Copy code");
    expect(html).not.toContain("Export as");
  });
});

describe("test 6 — an agent reply keeps execution collapsible", () => {
  const html = render(
    [
      { role: "user", content: "Inspect this project, find the bug and run the tests.", created_at: at(), metadata: { intent: "AGENT_TASK", artifact_type: "AGENT_TASK" } },
      {
        role: "assistant",
        content: "I found the root cause and the tests pass now.",
        created_at: at(),
        metadata: {
          mode: "agent",
          intent: "AGENT_TASK",
          artifact_type: "AGENT_TASK",
          artifacts: [{ path: "src/lib/session.ts", content: "export const x = 1;\n", language: "typescript" }],
          project_id: "p1",
        },
      },
    ],
    "agent",
  );

  it("offers the workspace, not a permanent sandbox", () => {
    expect(html).toContain("Open Agent workspace");
    expect(html).not.toContain("Live execution console");
    expect(html).not.toContain("Pipeline performance");
    // The stage list only mounts once the user opens the collapsed card.
    expect(html).not.toContain("Result Parser");
  });

  it("never prints a reasoning trace", () => {
    // "Reasoning" exists as a model lane label; what must never appear is a
    // rendered trace of the model's private thinking.
    expect(html).not.toMatch(/Thought for|Agent reasoning|chain of thought|Thinking…|Thinking\.\.\./i);
  });
});

describe("test 7 — a code answer gets code actions, no export clutter", () => {
  const html = render([
    { role: "user", content: "Write a Python function to sort a list.", created_at: at(), metadata: { intent: "CODE" } },
    {
      role: "assistant",
      content: "Here you go:\n\n```python\ndef sort_list(items):\n    return sorted(items)\n```",
      created_at: at(),
      metadata: { intent: "CODE", artifact_type: "CODE", mode: "code" },
    },
  ]);

  it("leads with code actions", () => {
    expect(html).toContain("Copy code");
    expect(html).toContain("Explain");
    expect(html).not.toContain("Export as");
    expect(html).not.toContain("Generate PDF");
    expect(html).not.toContain("Agent execution");
  });

  it("does not turn a snippet into a full workspace", () => {
    expect(html).not.toContain("Open Agent workspace");
    expect(html).not.toContain("Terminal");
  });
});

describe("ambiguous and refused requests", () => {
  it("offers a minimal format choice for 'make a report'", () => {
    const html = render([
      { role: "user", content: "Make a report.", created_at: at() },
      { role: "assistant", content: "# Report\n\nDraft contents.", created_at: at(), metadata: { intent: "FORMAT_CLARIFY" } },
    ]);
    expect(html).toContain("What format would you like?");
    expect(html).toContain("PDF");
    expect(html).toContain("DOCX");
    expect(html).toContain("Markdown");
    expect(html).not.toContain("CSV");
    expect(html).not.toContain("JSON");
  });

  it("hides export entirely when the user refused it", () => {
    const html = render([
      { role: "user", content: "Summarise this and don't export anything.", created_at: at() },
      { role: "assistant", content: "Here is the summary.", created_at: at(), metadata: { intent: "CHAT" } },
    ]);
    expect(html).not.toContain("Export as");
    expect(html).not.toContain("Generate PDF");
  });
});

describe("mode tools appear only with material to act on", () => {
  it("study mode folds flashcards until opened", () => {
    const html = render(
      [
        { role: "user", content: "Make flashcards for this.", created_at: at() },
        { role: "assistant", content: "Q: Capital of France?\nA: Paris\nQ: Largest ocean?\nA: Pacific", created_at: at(), metadata: { mode: "study" } },
      ],
      "study",
    );
    expect(html).toContain("Flashcards · 2");
    expect(html).not.toContain("Previous");
    expect(html).toContain("Quiz me");
  });

  it("general mode shows no mode tools", () => {
    const html = render([
      { role: "user", content: "hi", created_at: at() },
      { role: "assistant", content: "Hello!", created_at: at() },
    ]);
    expect(html).not.toContain("Quiz me");
    expect(html).not.toContain("Refactor");
    expect(html).not.toContain("Research desk");
    expect(html).not.toContain("Study mode");
  });
});
