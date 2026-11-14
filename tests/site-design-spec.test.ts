import { describe, expect, it } from "vitest";
import {
  analyzeBrief, classifyDesignRevision, createDesignSpec, designDistance, designFingerprint, formatDesignSpecForPrompt,
  isWebsiteRequest, mergeModelDesignSpec, paletteIssues, parseStoredDesignSpec, reviseDesignSpec, serializeDesignSpec,
  tailwindConfigSnippet,
} from "@/lib/design/site-spec";
import { designQualityCheck, significantDesignIssues } from "@/lib/deploy/design-quality";

const briefs = [
  "Build a website for a family-run Italian restaurant in Dhaka with a menu and reservations",
  "Create a portfolio website for a freelance brand photographer",
  "Build a SaaS landing page for an invoicing tool for accountants",
  "Create a website for a children's dental clinic",
  "Build an online store for handmade leather bags",
  "Make a website for a law firm specialising in corporate law",
];

describe("website design specification", () => {
  it("produces a different design for different briefs", () => {
    const specs = briefs.map((brief, i) => createDesignSpec(brief, { seed: `project-${i}` }));
    expect(new Set(specs.map((spec) => spec.industry)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(specs.map((spec) => spec.palette.primary)).size).toBe(specs.length);
    for (let a = 0; a < specs.length; a += 1) for (let b = a + 1; b < specs.length; b += 1) {
      expect(designDistance(specs[a], specs[b])).toBeGreaterThan(0.4);
    }
  });

  it("varies the same brief across projects but is stable for one project", () => {
    const brief = briefs[0];
    expect(createDesignSpec(brief, { seed: "p1" })).toEqual(createDesignSpec(brief, { seed: "p1" }));
    const variants = ["p1", "p2", "p3", "p4", "p5", "p6"].map((seed) => createDesignSpec(brief, { seed }));
    expect(new Set(variants.map((spec) => `${spec.direction.name}|${spec.palette.primary}|${spec.typography.heading}`)).size).toBeGreaterThanOrEqual(4);
  });

  it("every generated palette meets contrast requirements", () => {
    for (let i = 0; i < 40; i += 1) {
      const spec = createDesignSpec(briefs[i % briefs.length], { seed: `contrast-${i}` });
      expect(paletteIssues(spec.palette)).toEqual([]);
    }
  });

  it("honours colours, mode and pages the user asked for", () => {
    const spec = createDesignSpec("Build a dark restaurant website with a #112233 background and orange accent. Pages: Home, Menu, Contact", { seed: "x" });
    expect(spec.palette.mode).toBe("dark");
    expect(spec.palette.background.toLowerCase()).toBe("#112233");
    expect(spec.industry).toBe("restaurant");
    expect(spec.pages.map((page) => page.toLowerCase())).toEqual(expect.arrayContaining(["menu", "contact"]));
    expect(spec.userConstraints.length).toBeGreaterThan(0);
  });

  it("classifies revision requests by what they actually change", () => {
    expect(classifyDesignRevision("Redesign the whole site, make it look completely different").scopes).toContain("full-redesign");
    expect(classifyDesignRevision("Change the color scheme to green").scopes).toEqual(["palette"]);
    expect(classifyDesignRevision("Use a different font for headings").scopes).toEqual(["typography"]);
    expect(classifyDesignRevision("Redesign the navigation").scopes).toEqual(["navigation"]);
    expect(classifyDesignRevision("Fix the mobile layout, it overflows on phones").scopes).toContain("mobile");
    expect(classifyDesignRevision("Change the phone number to 01700000000")).toMatchObject({ scopes: ["none"], restyle: false });
    expect(classifyDesignRevision("Fix the typo in the footer")).toMatchObject({ scopes: ["none"], restyle: false });
  });

  it("a full redesign changes the visual identity; a palette change keeps the rest", () => {
    const original = createDesignSpec(briefs[0], { seed: "proj" });
    const redesign = reviseDesignSpec(original, "Redesign it completely with a new look", { seed: "proj", originalBrief: briefs[0] });
    expect(redesign.revision.restyle).toBe(true);
    expect(redesign.spec.palette.primary).not.toBe(original.palette.primary);
    expect(redesign.spec.direction.name).not.toBe(original.direction.name);
    expect(redesign.spec.industry).toBe(original.industry);
    expect(redesign.changed.length).toBeGreaterThan(1);

    const recolor = reviseDesignSpec(original, "Change the colors to a green palette", { seed: "proj", originalBrief: briefs[0] });
    expect(recolor.spec.palette.primary).not.toBe(original.palette.primary);
    expect(recolor.spec.typography).toEqual(original.typography);
    expect(recolor.spec.layout).toEqual(original.layout);

    const text = reviseDesignSpec(original, "Change the phone number to 01700000000", { seed: "proj", originalBrief: briefs[0] });
    expect(text.changed).toEqual([]);
    expect(text.spec.palette).toEqual(original.palette);
  });

  it("round-trips through storage and rejects malformed stored specs", () => {
    const spec = createDesignSpec(briefs[2], { seed: "store" });
    expect(parseStoredDesignSpec(JSON.parse(JSON.stringify(serializeDesignSpec(spec))))).toEqual(spec);
    expect(parseStoredDesignSpec(null)).toBeNull();
    expect(parseStoredDesignSpec({ version: 1, palette: "red" })).toBeNull();
  });

  it("accepts valid model refinements and rejects unreadable or off-brief ones", () => {
    const base = createDesignSpec("Build a restaurant website with a #112233 background", { seed: "m" });
    const merged = mergeModelDesignSpec(base, JSON.stringify({ palette: { primary: "#c2410c", background: "#ffffff" }, typography: { heading: "Fraunces" } }), "Build a restaurant website with a #112233 background");
    expect(merged.spec.palette.background.toLowerCase()).toBe("#112233"); // user constraint wins
    expect(paletteIssues(merged.spec.palette)).toEqual([]);
    const garbage = mergeModelDesignSpec(base, "I cannot do that", "x");
    expect(garbage.spec).toEqual(base);
    expect(garbage.applied).toEqual([]);
  });

  it("gives the model concrete Tailwind tokens", () => {
    const spec = createDesignSpec(briefs[1], { seed: "tw" });
    const snippet = tailwindConfigSnippet(spec);
    expect(snippet).toContain(spec.palette.primary);
    expect(snippet).toContain("tailwind.config");
    const prompt = formatDesignSpecForPrompt(spec);
    expect(prompt).toContain(spec.typography.heading);
    expect(prompt).toContain(spec.direction.name);
  });

  it("recognises website requests and analyses the brief", () => {
    expect(isWebsiteRequest("Build a landing page for my bakery")).toBe(true);
    expect(isWebsiteRequest("Write a python script to sort a CSV")).toBe(false);
    expect(isWebsiteRequest("make the header blue", ["index.html"])).toBe(true);
    expect(analyzeBrief("A website for a yoga studio").industry).not.toBe("general");
  });

  it("fingerprints the design of existing files", () => {
    const fp = designFingerprint([{ path: "index.html", content: '<html><head><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Inter"></head><body style="background:#112233"><section></section><section></section></body></html>' }, { path: "about.html", content: "<html></html>" }]);
    expect(fp.usesTailwind).toBe(true);
    expect(fp.colors).toContain("#112233");
    expect(fp.pages).toEqual(expect.arrayContaining(["index.html", "about.html"]));
  });
});

describe("static design quality check", () => {
  const good = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trattoria</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-background text-ink"><header><nav class="flex items-center justify-between p-4"><a href="#">Trattoria</a><button aria-label="Open menu" class="md:hidden">Menu</button><ul class="hidden md:flex gap-6"><li><a href="#menu">Menu</a></li></ul></nav></header><main><section class="px-4 py-16 md:py-24"><h1 class="text-4xl md:text-6xl">Fresh pasta daily</h1><p>Family recipes since 1982.</p><a class="rounded bg-primary px-5 py-3 hover:opacity-90 focus-visible:ring-2" href="#book">Book a table</a></section><section id="menu" class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 px-4 py-16"><h2>Menu</h2><article>Tagliatelle</article><article>Risotto</article><article>Tiramisu</article></section><section id="book" class="px-4 py-16"><h2>Reservations</h2><form><label for="n">Name</label><input id="n" name="name"><button type="submit">Send</button></form></section></main><footer class="p-6">© Trattoria</footer></body></html>`;

  it("passes a structured, responsive page", () => {
    const check = designQualityCheck([{ path: "index.html", language: "html", content: good }]);
    expect(check.id).toBe("design");
    expect(significantDesignIssues(check)).toEqual([]);
  });

  it("flags an unstyled, non-responsive page", () => {
    const check = designQualityCheck([{ path: "index.html", language: "html", content: "<html><body><h1>Welcome to our shop</h1><p>We sell many good things for your home and garden, every day of the week.</p></body></html>" }]);
    expect(significantDesignIssues(check).length).toBeGreaterThan(0);
    expect(JSON.stringify(check)).toMatch(/viewport|responsive|breakpoint|mobile/i);
    const empty = designQualityCheck([{ path: "index.html", language: "html", content: "<html><body><h1>Hi</h1></body></html>" }]);
    expect(empty.status).toBe("failed");
  });

  it("reports pages the brief asked for that were not built", () => {
    const check = designQualityCheck([{ path: "index.html", language: "html", content: good }], { expectedPages: ["Home", "Pricing"], requirePages: true });
    expect(JSON.stringify(check)).toMatch(/pricing/i);
  });
});
