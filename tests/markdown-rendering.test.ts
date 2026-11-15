import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/markdown";
import { parseBlocks, sameBlock } from "@/lib/markdown/blocks";
import { inlineText, parseInline } from "@/lib/markdown/inline";

const html = (text: string, streaming = false) => renderToStaticMarkup(createElement(Markdown, { text, streaming }));

describe("inline formatting", () => {
  it("parses bold, italic, strike, code and nested emphasis", () => {
    expect(parseInline("A **bold** and *soft* and ~~gone~~ `code`")).toEqual([
      { t: "text", v: "A " }, { t: "strong", c: [{ t: "text", v: "bold" }] },
      { t: "text", v: " and " }, { t: "em", c: [{ t: "text", v: "soft" }] },
      { t: "text", v: " and " }, { t: "del", c: [{ t: "text", v: "gone" }] },
      { t: "text", v: " " }, { t: "code", v: "code" },
    ]);
    expect(parseInline("__bold__ and _soft_, done.")).toMatchObject([{ t: "strong" }, { t: "text", v: " and " }, { t: "em" }, { t: "text", v: ", done." }]);
    expect(parseInline("***both***")).toEqual([{ t: "strong", c: [{ t: "em", c: [{ t: "text", v: "both" }] }] }]);
    expect(parseInline("*a **b** c*")).toEqual([{ t: "em", c: [{ t: "text", v: "a " }, { t: "strong", c: [{ t: "text", v: "b" }] }, { t: "text", v: " c" }] }]);
    expect(parseInline("**bold with `code` inside**")[0]).toMatchObject({ t: "strong", c: [{ t: "text", v: "bold with " }, { t: "code", v: "code" }, { t: "text", v: " inside" }] });
  });

  it("leaves arithmetic, snake_case and unclosed markers as literal text", () => {
    for (const text of ["2 * 3 = 6", "2*3*4", "my_variable_name is set", "file_name.txt", "a ** b", "an unclosed *marker", "5 < 6 and 7 > 2", "__init__.py"]) {
      expect(inlineText(parseInline(text))).toBe(text);
      expect(parseInline(text).every((node) => node.t === "text")).toBe(true);
    }
  });

  it("keeps the contents of code spans literal", () => {
    expect(parseInline("Use `**not bold**` here")[1]).toEqual({ t: "code", v: "**not bold**" });
    expect(parseInline("``a ` b``")).toEqual([{ t: "code", v: "a ` b" }]);
    expect(parseInline("Run `npm i")).toEqual([{ t: "text", v: "Run `npm i" }]);
  });

  it("links only safe schemes and trims sentence punctuation from bare URLs", () => {
    expect(parseInline("[docs](https://example.com/a_(b))")).toEqual([{ t: "link", href: "https://example.com/a_(b)", c: [{ t: "text", v: "docs" }] }]);
    expect(parseInline("See https://example.com/path?x=1. Then")).toEqual([
      { t: "text", v: "See " }, { t: "link", href: "https://example.com/path?x=1", c: [{ t: "text", v: "https://example.com/path?x=1" }] }, { t: "text", v: ". Then" },
    ]);
    expect(parseInline("(https://example.com)")[1]).toMatchObject({ t: "link", href: "https://example.com" });
    expect(parseInline("[x](javascript:alert(1))").every((node) => node.t === "text")).toBe(true);
    expect(parseInline("[x](data:text/html,hi)").every((node) => node.t === "text")).toBe(true);
    expect(parseInline("mail <mailto:a@b.co>")[1]).toMatchObject({ t: "link", href: "mailto:a@b.co" });
    // Inline images become links: third-party images are never auto-fetched.
    expect(parseInline("![chart](https://cdn.example.com/c.png)")).toEqual([{ t: "link", href: "https://cdn.example.com/c.png", c: [{ t: "text", v: "chart" }] }]);
  });

  it("recognises inline math but not money", () => {
    expect(parseInline("Energy is $E = mc^2$ here")[1]).toEqual({ t: "math", v: "E = mc^2" });
    expect(parseInline("so \\(a^2 + b^2\\) holds")[1]).toEqual({ t: "math", v: "a^2 + b^2" });
    expect(parseInline("inline $$x^2$$ display")[1]).toEqual({ t: "math", v: "x^2", display: true });
    for (const money of ["It costs $5 and $10 total", "Price: $5-$10", "Pay $20 or $30.", "US$5 and US$6", "only $ one"]) {
      expect(parseInline(money).some((node) => node.t === "math")).toBe(false);
    }
  });

  it("turns <br> into a line break and honours backslash escapes", () => {
    expect(parseInline("a<br>b<br/>c")).toEqual([{ t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b" }, { t: "br" }, { t: "text", v: "c" }]);
    expect(inlineText(parseInline("\\*not emphasis\\*"))).toBe("*not emphasis*");
  });
});

describe("block structure", () => {
  it("keeps heading levels and renders real heading elements", () => {
    const blocks = parseBlocks("# One\n## Two\n### Three\n#### Four\n## About C#");
    expect(blocks).toEqual([
      { type: "h", text: "One", level: 1 }, { type: "h", text: "Two", level: 2 },
      { type: "h", text: "Three", level: 3 }, { type: "h", text: "Four", level: 4 },
      { type: "h", text: "About C#", level: 2 },
    ]);
    const out = html("# One\n\n## Two\n\n### Three");
    expect(out).toContain("<h2 class=\"md-h1\">One</h2>");
    expect(out).toContain("<h3 class=\"md-h2\">Two</h3>");
    expect(out).toContain("<h4 class=\"md-h3\">Three</h4>");
  });

  it("merges soft-wrapped lines into one paragraph", () => {
    expect(parseBlocks("line one\nline two\n\nnext")).toEqual([{ type: "p", text: "line one\nline two" }, { type: "p", text: "next" }]);
  });

  it("nests lists by indentation and never skips a level", () => {
    const [list] = parseBlocks("- a\n  - a1\n    - a1x\n  - a2\n- b\n        - too deep");
    expect(list.type).toBe("ul");
    expect((list as { items: Array<{ text: string; depth: number }> }).items.map((item) => [item.text, item.depth])).toEqual([
      ["a", 0], ["a1", 1], ["a1x", 2], ["a2", 1], ["b", 0], ["too deep", 1],
    ]);
    const out = html("- a\n  - a1\n- b");
    expect(out).toMatch(/<ul><li><span[^>]*>a<\/span><ul><li><span[^>]*>a1<\/span><\/li><\/ul><\/li><li><span[^>]*>b<\/span><\/li><\/ul>/);
  });

  it("keeps a loose ordered list as one list and preserves a non-1 start", () => {
    const loose = parseBlocks("1. First\n\n2. Second\n\n3. Third");
    expect(loose).toHaveLength(1);
    expect(loose[0]).toMatchObject({ type: "ol", items: [{ text: "First", number: 1 }, { text: "Second", number: 2 }, { text: "Third", number: 3 }] });
    const split = parseBlocks("1. First\n\nA paragraph in between.\n\n2. Second");
    expect(split.map((block) => block.type)).toEqual(["ol", "p", "ol"]);
    expect(html("1. First\n\nA paragraph in between.\n\n2. Second")).toContain("<ol start=\"2\">");
  });

  it("supports mixed nested kinds, continuation lines and task items", () => {
    const [mixed] = parseBlocks("1. Step\n   - detail\n   continued detail\n2. Next");
    expect(mixed).toMatchObject({ type: "ol", items: [
      { text: "Step", depth: 0, ordered: true }, { text: "detail\ncontinued detail", depth: 1, ordered: false }, { text: "Next", depth: 0, ordered: true },
    ] });
    const [tasks] = parseBlocks("- [x] shipped\n- [ ] pending");
    expect(tasks).toMatchObject({ items: [{ text: "shipped", task: "done" }, { text: "pending", task: "open" }] });
    const out = html("- [x] shipped\n- [ ] pending");
    expect(out).toContain("type=\"checkbox\"");
    expect(out).toContain("aria-label=\"Completed\"");
    expect(out).toContain("aria-label=\"Not completed\"");
  });

  it("does not mistake prose for lists or rules", () => {
    expect(parseBlocks("-5 degrees outside")[0].type).toBe("p");
    expect(parseBlocks("**Bold** start of a line")[0].type).toBe("p");
    expect(parseBlocks("1990 was a year.")[0].type).toBe("p");
    expect(parseBlocks("---")[0]).toEqual({ type: "hr" });
    expect(parseBlocks("***")[0]).toEqual({ type: "hr" });
    expect(html("above\n\n---\n\nbelow")).toContain("<hr/>");
  });

  it("parses table alignment, escaped pipes and pipes inside code", () => {
    const [table] = parseBlocks("| Name | Qty | Note |\n| :--- | ---: | :-: |\n| a \\| b | 2 | `x | y` |\n| c | 10 |");
    expect(table).toEqual({
      type: "table",
      align: ["left", "right", "center"],
      rows: [["Name", "Qty", "Note"], ["a | b", "2", "`x | y`"], ["c", "10"]],
    });
    const out = html("| Name | Qty |\n| --- | ---: |\n| **a** | 2 |\n| c |");
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("<th scope=\"col\"");
    expect(out).toContain("text-right");
    expect(out).toContain("<strong>a</strong>");
    // A short row is padded, never shifted into the wrong column.
    expect((out.match(/<td /g) ?? []).length).toBe(4);
  });

  it("recognises display math in every common notation", () => {
    expect(parseBlocks("$$\nx^2\n$$")[0]).toEqual({ type: "math", text: "x^2" });
    expect(parseBlocks("$$x^2 + 1$$")[0]).toEqual({ type: "math", text: "x^2 + 1" });
    expect(parseBlocks("\\[\n\\frac{a}{b}\n\\]")[0]).toEqual({ type: "math", text: "\\frac{a}{b}" });
    expect(parseBlocks("\\[ a + b \\]")[0]).toEqual({ type: "math", text: "a + b" });
    // Still streaming: flagged open so the renderer shows readable source.
    expect(parseBlocks("$$\nx^2 +")[0]).toEqual({ type: "math", text: "x^2 +", open: true });
    const out = html("$$\nx^2 + y^2\n$$");
    expect(out).toContain("x^2 + y^2");
    expect(out).toContain("math-block");
  });

  it("supports ~~~ fences and keeps a fence open while it streams", () => {
    expect(parseBlocks("~~~py\nprint(1)\n~~~")[0]).toMatchObject({ type: "code", lang: "python", code: "print(1)" });
    expect(parseBlocks("```js\nconst a = `x`;\n```\n\nafter").map((block) => block.type)).toEqual(["code", "p"]);
    expect(parseBlocks("```ts\nconst a = 1;").at(-1)).toMatchObject({ type: "code", open: true });
  });

  it("escapes raw HTML instead of rendering it — in prose and as a whole reply", () => {
    const prose = html("Use a <b> tag for bold and an <img src=x onerror=alert(1)> for images.");
    expect(prose).toContain("&lt;b&gt;");
    expect(prose).not.toContain("<img");
    expect(prose).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // A tag-rich reply is shown as source in a code block, never executed.
    const markup = html("Use the <script>alert(1)</script> tag carefully in a sentence that is long enough.");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script");
    expect(markup).toContain("code-block");
  });
});

describe("streaming stability", () => {
  it("only ever changes the last block as text is appended", () => {
    const full = "# Title\n\nIntro paragraph.\n\n1. one\n2. two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\nClosing **bold** line.";
    let previous = parseBlocks("");
    for (let cut = 1; cut <= full.length; cut += 1) {
      const next = parseBlocks(full.slice(0, cut));
      // Every block before the last one that existed is unchanged or (at most)
      // the previous last block finished growing.
      for (let i = 0; i < Math.min(previous.length, next.length) - 1; i += 1) {
        expect(sameBlock(previous[i], next[i])).toBe(true);
      }
      expect(next.length).toBeGreaterThanOrEqual(previous.length - 1);
      previous = next;
    }
    expect(previous.map((block) => block.type)).toEqual(["h", "p", "ol", "table", "code", "p"]);
  });

  it("marks only the growing block as live", () => {
    const out = html("Done paragraph.\n\nStill **typ", true);
    expect(out).toContain("data-streaming=\"true\"");
    expect(out).toContain("<strong>typ</strong>");
    expect(html("Done paragraph.\n\nStill **typ")).not.toContain("data-streaming");
  });
});

describe("mobile safety", () => {
  it("ships no regex lookbehind in browser code (older Safari cannot parse it)", () => {
    for (const file of ["src/lib/markdown/inline.ts", "src/lib/markdown/blocks.ts", "src/components/markdown.tsx", "src/lib/code-blocks.ts"]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/\(\?<[=!]/);
    }
  });

  it("keeps wide content inside its own scroll box", () => {
    const out = html("```bash\n" + "x".repeat(400) + "\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toMatch(/<pre class="max-w-full overflow-x-auto"/);
    expect(out).toMatch(/class="table-wrap[^"]*overflow-x-auto/);
    const css = readFileSync("src/styles/chat.css", "utf8");
    expect(css).toMatch(/\.code-block pre \{[^}]*overflow-x: auto/);
    expect(css).toMatch(/\.math-block \{[^}]*overflow-x: auto/);
  });

  it("loads KaTeX on demand only", () => {
    const math = readFileSync("src/components/math.tsx", "utf8");
    expect(math).toContain("import(\"@/lib/katex-runtime\")");
    expect(math).not.toMatch(/^import .*from "katex"/m);
    expect(math).toContain("trust: false");
    expect(readFileSync("src/components/markdown.tsx", "utf8")).not.toMatch(/from "katex"/);
  });
});
