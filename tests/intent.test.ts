import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTENT, analyzeContent, availableExportFormats, classifyResponseKind, detectIntent,
  detectExportFormats, effectiveMode, planResponseActions, selectCapability,
} from "../src/lib/ai/intent";

// The exact scenarios from the product spec (§32).
describe("intent detection — normal chat stays chat", () => {
  it("test 1: 'hi' asks for nothing", () => {
    const result = detectIntent("hi");
    expect(result.intent).toBe("CHAT");
    expect(result.artifact).toBe("NONE");
    expect(result.artifactRequested).toBe(false);
    expect(result.formats).toEqual([]);
    expect(result.needsFormatChoice).toBe(false);
  });

  it("test 2: 'Explain photosynthesis.' asks for nothing", () => {
    const result = detectIntent("Explain photosynthesis.");
    expect(result.intent).toBe("CHAT");
    expect(result.artifact).toBe("NONE");
  });

  it("questions about a format are not export requests", () => {
    expect(detectIntent("What is Python?").intent).toBe("CHAT");
    expect(detectIntent("What is a PDF?").intent).toBe("CHAT");
    expect(detectIntent("How do I export data from Excel to CSV in Python?").intent).toBe("CHAT");
    expect(detectExportFormats("Explain how CSV files work")).toEqual([]);
  });

  it("greetings and small talk never select a capability", () => {
    for (const text of ["hello", "hey there", "thanks!", "What is JavaScript?", "Explain gravity."]) {
      const result = detectIntent(text);
      expect(result.intent, text).toBe("CHAT");
      expect(result.artifact, text).toBe("NONE");
      expect(selectCapability(result, "general"), text).toBe("chat");
    }
  });

  it("defaults are clean", () => {
    expect(DEFAULT_INTENT.artifact).toBe("NONE");
    expect(DEFAULT_INTENT.artifactRequested).toBe(false);
    expect(detectIntent("").intent).toBe("CHAT");
  });
});

describe("intent detection — explicit artifacts", () => {
  it("test 3: PDF requests", () => {
    for (const text of [
      "Turn this answer into a PDF.",
      "Make this a PDF.",
      "Export this as PDF.",
      "Create a PDF report.",
      "Save this as a pdf file",
    ]) {
      const result = detectIntent(text);
      expect(result.intent, text).toBe("EXPORT");
      expect(result.artifact, text).toBe("PDF");
      expect(result.artifactRequested, text).toBe(true);
      expect(result.formats, text).toContain("pdf");
    }
  });

  it("test 4: CSV requests", () => {
    for (const text of ["Create a CSV from this table.", "Give me this data as CSV.", "Create a CSV containing these 100 users."]) {
      const result = detectIntent(text);
      expect(result.intent, text).toBe("EXPORT");
      expect(result.artifact, text).toBe("CSV");
    }
  });

  it("JSON is only detected when asked for", () => {
    expect(detectIntent("Return this as JSON.").artifact).toBe("JSON");
    expect(detectIntent("Give me the API payload in json").artifact).toBe("JSON");
    expect(detectIntent("Tell me about JSON Schema.").artifact).toBe("NONE");
  });

  it("DOCX, XLSX, TXT and Markdown are recognised", () => {
    expect(detectIntent("Export this as a Word document").artifact).toBe("DOCX");
    expect(detectIntent("Put this table into an Excel file").artifact).toBe("XLSX");
    expect(detectIntent("Save this as a plain text file").artifact).toBe("TXT");
    expect(detectIntent("Convert this to markdown").artifact).toBe("MARKDOWN");
  });

  it("test 20: 'Make a report.' never guesses a format", () => {
    const result = detectIntent("Make a report.");
    expect(result.intent).toBe("FORMAT_CLARIFY");
    expect(result.artifact).toBe("NONE");
    expect(result.artifactRequested).toBe(false);
    expect(result.needsFormatChoice).toBe(true);
    expect(result.formatChoices).toEqual(["pdf", "docx", "markdown"]);
  });

  it("test 21: an explicit refusal is respected", () => {
    const result = detectIntent("Summarise this, but don't export anything.");
    expect(result.suppressExport).toBe(true);
    expect(result.artifact).toBe("NONE");
    expect(detectIntent("Just answer, no export needed as PDF").formats).toEqual([]);
  });
});

describe("intent detection — image, agent and code", () => {
  it("test 5: explicit image generation uses Together AI", () => {
    for (const text of [
      "Generate an image of a futuristic Matrix city.",
      "Create a cyberpunk poster.",
      "Generate a logo for Matrix.",
      "Draw an illustration of a neural network.",
    ]) {
      const result = detectIntent(text);
      expect(result.intent, text).toBe("IMAGE_GENERATION");
      expect(result.artifact, text).toBe("IMAGE");
      expect(result.provider, text).toBe("together_ai");
      expect(selectCapability(result, "general"), text).toBe("image");
    }
  });

  it("normal messages never trigger image generation", () => {
    for (const text of ["hi", "Explain photosynthesis.", "What is an image sensor?", "How do I compress an image?"]) {
      expect(detectIntent(text).intent, text).not.toBe("IMAGE_GENERATION");
    }
  });

  it("test 6: multi-step execution requests become agent tasks", () => {
    for (const text of [
      "Inspect this project, find the bug and run the tests.",
      "Analyze my project and fix the errors.",
      "Review the attached files, refactor the auth module and deploy the build.",
    ]) {
      const result = detectIntent(text);
      expect(result.intent, text).toBe("AGENT_TASK");
      expect(result.artifact, text).toBe("AGENT_TASK");
      expect(selectCapability(result, "general"), text).toBe("agent");
    }
  });

  it("a single coding question is not an agent task", () => {
    expect(detectIntent("Fix this bug in my sort function").intent).toBe("CODE");
    expect(detectIntent("What is a closure in JavaScript?").intent).toBe("CHAT");
  });

  it("test 7: code requests", () => {
    for (const text of ["Write a Python function to sort a list.", "Write a React component.", "Debug this Python code.", "Implement a REST endpoint for users."]) {
      const result = detectIntent(text);
      expect(result.intent, text).toBe("CODE");
    }
  });

  it("pasted code counts as a code request", () => {
    const result = detectIntent("```py\nprint('hi')\n```\nwhy is this slow?");
    expect(result.intent).toBe("CODE");
  });

  it("domain intents shape the answer without creating artifacts", () => {
    expect(detectIntent("Quiz me on Newton's laws").intent).toBe("STUDY");
    expect(detectIntent("Find sources and evidence about climate feedback loops").intent).toBe("RESEARCH");
    expect(detectIntent("What are common side effects of ibuprofen?").intent).toBe("HEALTH");
    expect(detectIntent("Quiz me on Newton's laws").artifactRequested).toBe(false);
  });

  it("a code task that names a file format keeps both", () => {
    const result = detectIntent("Write a Python function and export it as a PDF.");
    expect(result.intent).toBe("CODE");
    expect(result.artifact).toBe("PDF");
    expect(result.artifactRequested).toBe(true);
  });
});

describe("capability selection and mode overrides", () => {
  it("mode drives capability when the message is neutral", () => {
    expect(detectIntent("hi", { mode: "image" }).intent).toBe("IMAGE_GENERATION");
    expect(detectIntent("hi", { mode: "agent" }).intent).toBe("AGENT_TASK");
    expect(detectIntent("hi", { mode: "code" }).intent).toBe("CODE");
    expect(selectCapability(detectIntent("hi", { mode: "orchestrator" }), "orchestrator")).toBe("orchestrate");
  });

  it("explicit user wording beats the active mode", () => {
    const result = detectIntent("Turn this into a PDF.", { mode: "agent" });
    expect(result.artifact).toBe("PDF");
    expect(result.artifactRequested).toBe(true);
  });

  it("effectiveMode upgrades only the message that needs it", () => {
    expect(effectiveMode(detectIntent("Generate an image of a neon city"), "general")).toBe("image");
    expect(effectiveMode(detectIntent("Inspect the repo and run the tests"), "general")).toBe("agent");
    expect(effectiveMode(detectIntent("hi"), "general")).toBe("general");
    expect(effectiveMode(detectIntent("hi"), "study")).toBe("study");
  });

  it("composer capabilities activate without auto-invoking", () => {
    expect(detectIntent("hi", { codeCapability: true }).intent).toBe("CODE");
    expect(detectIntent("hi", { imageCapability: true }).intent).toBe("IMAGE_GENERATION");
  });
});

describe("response content analysis", () => {
  const prose = "Python is a high-level programming language. It is widely used for web development and data analysis.";

  it("plain prose exposes no structured data", () => {
    const signals = analyzeContent(prose);
    expect(signals.hasTable).toBe(false);
    expect(signals.hasCsvData).toBe(false);
    expect(signals.hasJson).toBe(false);
    expect(signals.hasCodeBlock).toBe(false);
    expect(availableExportFormats(signals)).toEqual(["pdf", "docx", "markdown", "txt"]);
  });

  it("a markdown table enables CSV, and only then", () => {
    const signals = analyzeContent("| Name | Age |\n| --- | --- |\n| Ada | 36 |\n| Linus | 54 |");
    expect(signals.hasTable).toBe(true);
    expect(availableExportFormats(signals)).toContain("csv");
  });

  it("a json block enables JSON export", () => {
    const signals = analyzeContent("Here you go:\n```json\n{\"users\": [{\"id\": 1, \"name\": \"Ada\"}]}\n```");
    expect(signals.hasJson).toBe(true);
    expect(signals.hasCodeBlock).toBe(true);
    expect(signals.codeLanguages).toContain("json");
    expect(availableExportFormats(signals)).toContain("json");
  });

  it("code, sources and flashcards are detected", () => {
    expect(analyzeContent("```python\ndef sort(xs):\n    return sorted(xs)\n```").codeLanguages).toContain("python");
    expect(analyzeContent("Findings\n\nSources:\n- https://example.org/study").hasSources).toBe(true);
    expect(analyzeContent("Q: Capital of France?\nA: Paris").hasFlashcards).toBe(true);
  });

  it("long structured answers read as documents", () => {
    const long = `# Report\n\n${Array.from({ length: 60 }, (_, i) => `- Section ${i} explains an important detail about the topic.`).join("\n")}`;
    expect(analyzeContent(long).isDocument).toBe(true);
    expect(analyzeContent(prose).isDocument).toBe(false);
  });
});

describe("contextual response actions", () => {
  const base = {
    intent: "CHAT" as const,
    mode: "general" as const,
    signals: analyzeContent("Hello! How can I help you?"),
    artifactType: "NONE" as const,
    artifactReady: false,
    hasExecution: false,
    hasAnalytics: false,
    canRun: false,
    canListen: true,
    canExport: true,
  };

  it("a normal reply gets Copy, Regenerate and More only", () => {
    const plan = planResponseActions(base);
    expect(plan.primary).toEqual(["copy", "regenerate"]);
    expect(plan.primary).not.toContain("export");
    expect(plan.overflow).toContain("export");
    expect(plan.overflow).toContain("report");
    expect(plan.overflow).not.toContain("run");
    expect(plan.overflow).not.toContain("activity");
    expect(plan.overflow).not.toContain("performance");
  });

  it("code replies lead with code actions and gate Run", () => {
    const signals = analyzeContent("```python\ndef f():\n    return 1\n```");
    expect(planResponseActions({ ...base, signals }).primary[0]).toBe("copyCode");
    expect(planResponseActions({ ...base, signals }).primary).not.toContain("run");
    expect(planResponseActions({ ...base, signals, canRun: true }).primary).toContain("run");
    expect(planResponseActions({ ...base, signals }).primary).toContain("explain");
  });

  it("image replies offer save, regenerate and edit prompt", () => {
    const plan = planResponseActions({ ...base, intent: "IMAGE_GENERATION", artifactType: "IMAGE", canListen: false });
    expect(plan.primary).toEqual(["save", "regenerate", "editPrompt"]);
  });

  it("research replies surface sources only when there are sources", () => {
    const withSources = analyzeContent("Answer\n\nSources:\n- https://example.org");
    expect(planResponseActions({ ...base, intent: "RESEARCH", signals: withSources }).primary).toContain("sources");
    expect(planResponseActions({ ...base, intent: "RESEARCH" }).primary).not.toContain("sources");
  });

  it("documents offer Open only once the artifact is ready", () => {
    expect(planResponseActions({ ...base, artifactType: "PDF" }).primary).not.toContain("open");
    expect(planResponseActions({ ...base, artifactType: "PDF", artifactReady: true }).primary).toContain("open");
  });

  it("execution detail appears only when something really ran", () => {
    expect(planResponseActions({ ...base }).overflow).not.toContain("activity");
    expect(planResponseActions({ ...base, mode: "agent", hasExecution: true }).primary).toContain("activity");
    expect(planResponseActions({ ...base, hasAnalytics: true, hasExecution: true }).overflow).toContain("performance");
  });

  it("a refused export removes export everywhere", () => {
    const plan = planResponseActions({ ...base, canExport: false });
    expect(plan.primary).not.toContain("export");
    expect(plan.overflow).not.toContain("export");
  });

  it("mobile keeps a single visible action plus More", () => {
    const plan = planResponseActions({ ...base, compact: true });
    expect(plan.primary).toHaveLength(1);
    expect(plan.overflow).toContain("regenerate");
  });

  it("response kinds are classified from content and intent", () => {
    expect(classifyResponseKind({ intent: "CHAT", mode: "general", signals: base.signals, artifactType: "NONE" })).toBe("chat");
    expect(classifyResponseKind({ intent: "CODE", mode: "general", signals: base.signals, artifactType: "NONE" })).toBe("code");
    expect(classifyResponseKind({ intent: "IMAGE_GENERATION", mode: "image", signals: base.signals, artifactType: "IMAGE" })).toBe("image");
    expect(classifyResponseKind({ intent: "EXPORT", mode: "general", signals: base.signals, artifactType: "CSV" })).toBe("data");
    expect(classifyResponseKind({ intent: "AGENT_TASK", mode: "agent", signals: base.signals, artifactType: "AGENT_TASK" })).toBe("agent");
  });
});
