import { describe, expect, it } from "vitest";
import { preferredSpeechLang, speechTextFromMarkdown } from "../src/lib/chat-speech";

describe("speechTextFromMarkdown", () => {
  it("strips fences, emphasis, links and headings into speakable prose", () => {
    const md = `# Hello\n\nThis is **bold** and *italic* with a [link](https://example.com) and \`code\`.\n\n\`\`\`js\nconsole.log(1)\n\`\`\`\n`;
    const spoken = speechTextFromMarkdown(md);
    expect(spoken).toContain("Hello");
    expect(spoken).toContain("bold");
    expect(spoken).toContain("italic");
    expect(spoken).toContain("link");
    expect(spoken).not.toContain("```");
    expect(spoken).not.toContain("https://");
    expect(spoken).not.toContain("#");
  });

  it("collapses lists into a single line", () => {
    expect(speechTextFromMarkdown("- one\n- two")).toBe("one two");
  });
});

describe("preferredSpeechLang", () => {
  it("uses Bangla when the reply contains Bengali script", () => {
    expect(preferredSpeechLang("হ্যালো, কেমন আছো?", "en")).toBe("bn-BD");
  });

  it("follows the UI locale otherwise", () => {
    expect(preferredSpeechLang("Hello there", "bn")).toBe("bn-BD");
    expect(preferredSpeechLang("Hello there", "en")).toBe("en-US");
  });
});
