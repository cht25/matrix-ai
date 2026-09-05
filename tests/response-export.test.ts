import { describe, expect, it, vi } from "vitest";
import {
  buildArtifact, exportCsv, exportDocxBytes, exportFilename, exportXlsxBytes,
  extractJson, extractTableRows, rowsToCsv, toPlainText,
} from "../src/lib/export/response-export";
import { crc32, zipEntries, zipRead, zipStore } from "../src/lib/export/zip";

const PROSE = "Python is a high-level programming language. It is popular for scripting, data analysis and the web.";
const TABLE = [
  "Here are the users you asked for:",
  "",
  "| Name | Age | City |",
  "| --- | --- | --- |",
  "| Ada Lovelace | 36 | London |",
  "| Linus Torvalds | 54 | Helsinki |",
  "| Grace Hopper | 45 | New York |",
].join("\n");
const JSON_REPLY = 'Sure:\n\n```json\n{"users": [{"id": 1, "name": "Ada"}, {"id": 2, "name": "Grace"}]}\n```';

describe("tabular extraction", () => {
  it("reads a markdown table", () => {
    const rows = extractTableRows(TABLE);
    expect(rows).not.toBeNull();
    expect(rows![0]).toEqual(["Name", "Age", "City"]);
    expect(rows![1]).toEqual(["Ada Lovelace", "36", "London"]);
    expect(rows!).toHaveLength(4);
  });

  it("reads a fenced csv block", () => {
    const rows = extractTableRows("Data:\n```csv\nid,name\n1,Ada\n2,Grace\n```");
    expect(rows).toEqual([["id", "name"], ["1", "Ada"], ["2", "Grace"]]);
  });

  it("reads loose comma separated rows", () => {
    const rows = extractTableRows("1,Ada,London\n2,Grace,New York\n3,Linus,Helsinki");
    expect(rows).toHaveLength(3);
    expect(rows![0]).toEqual(["1", "Ada", "London"]);
  });

  it("refuses to invent a table out of prose", () => {
    expect(extractTableRows(PROSE)).toBeNull();
    expect(exportCsv(PROSE)).toBeNull();
  });

  it("quotes and escapes CSV cells", () => {
    expect(rowsToCsv([["a", 'say "hi"', "x,y"]])).toBe('a,"say ""hi""","x,y"\r\n');
    // RFC 4180: only cells that need quoting get quotes.
    expect(exportCsv(TABLE)).toContain("Ada Lovelace,36,London");
    expect(exportCsv(TABLE)).not.toContain('"Ada Lovelace"');
    expect(exportCsv("| a | b |\n| --- | --- |\n| plain | has, comma |")).toContain('"has, comma"');
  });
});

describe("json extraction", () => {
  it("pulls the payload out of a fenced block and pretty prints it", () => {
    const json = extractJson(JSON_REPLY);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!).users).toHaveLength(2);
  });

  it("finds a bare object", () => {
    expect(JSON.parse(extractJson('Result: {"ok": true, "count": 3}')!).ok).toBe(true);
  });

  it("returns null when there is no json", () => {
    expect(extractJson(PROSE)).toBeNull();
  });
});

describe("buildArtifact — only honest formats", () => {
  it("builds a real PDF for prose through the shared engine", async () => {
    // PDFs are rendered server-side (embedded Unicode fonts + shaping), so the
    // exporter posts to /api/export/pdf. Stub the transport and assert the
    // request, not a hand-rolled byte layout.
    const calls: Array<{ url: string; body: unknown }> = [];
    const pdf = new TextEncoder().encode("%PDF-1.7\nstub\n%%EOF" + "x".repeat(2000));
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } });
    });

    const built = await buildArtifact("pdf", PROSE, "About Python");
    expect(built).not.toBeNull();
    expect(built!.filename).toBe("about-python.pdf");
    expect(built!.mime).toBe("application/pdf");
    expect(new TextDecoder().decode(built!.data as Uint8Array).startsWith("%PDF")).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/export/pdf");
    expect(calls[0].body).toMatchObject({ title: "About Python" });
    expect((calls[0].body as { content: string }).content).toContain("programming language");
    vi.unstubAllGlobals();
  });

  it("never hands back a suspiciously empty PDF", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(12), { status: 200 }));
    await expect(buildArtifact("pdf", PROSE, "Tiny")).rejects.toThrow(/PDF_EXPORT_EMPTY/);
    vi.unstubAllGlobals();
  });

  it("surfaces a failed PDF render instead of writing a broken file", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await expect(buildArtifact("pdf", PROSE, "Broken")).rejects.toThrow(/PDF_EXPORT_FAILED_500/);
    vi.unstubAllGlobals();
  });

  it("builds a zipped DOCX package", async () => {
    const built = await buildArtifact("docx", `# Title\n\nSome **bold** text.\n\n- one\n- two\n\n\`\`\`py\nprint(1)\n\`\`\``, "Field Notes");
    expect(built!.filename).toBe("field-notes.docx");
    const archive = built!.data as Uint8Array;
    const names = zipEntries(archive).map((entry) => entry.name);
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("word/document.xml");
    const document = new TextDecoder().decode(zipRead(archive, "word/document.xml")!);
    expect(document).toContain("wordprocessingml/2006/main");
    expect(document).toContain("Field Notes");
    expect(document).toContain("<w:b/>");
    expect(document).toContain("print(1)");
    expect(document).toContain("<w:numPr>");
  });

  it("builds a real XLSX workbook from a table", async () => {
    const built = await buildArtifact("xlsx", TABLE, "Users");
    expect(built).not.toBeNull();
    expect(built!.filename).toBe("users.xlsx");
    const archive = built!.data as Uint8Array;
    const names = zipEntries(archive).map((entry) => entry.name);
    expect(names).toContain("xl/workbook.xml");
    expect(names).toContain("xl/worksheets/sheet1.xml");
    const sheet = new TextDecoder().decode(zipRead(archive, "xl/worksheets/sheet1.xml")!);
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>36</v></c>');
    const workbook = new TextDecoder().decode(zipRead(archive, "xl/workbook.xml")!);
    expect(workbook).toContain('name="Users"');
  });

  it("never builds a spreadsheet out of prose", async () => {
    expect(await buildArtifact("csv", PROSE)).toBeNull();
    expect(await buildArtifact("xlsx", PROSE)).toBeNull();
  });

  it("builds CSV only from tabular data", async () => {
    const built = await buildArtifact("csv", TABLE, "Users");
    expect(built!.filename).toBe("users.csv");
    expect(built!.mime).toBe("text/csv;charset=utf-8");
    expect(built!.preview).toContain("Name,Age,City");
  });

  it("builds markdown, txt and json", async () => {
    expect((await buildArtifact("markdown", PROSE, "Python"))!.preview).toBe(`# Python\n\n${PROSE}\n`);
    expect((await buildArtifact("txt", "# Heading\n\n**bold** text", "Doc"))!.preview).toBe("Heading\n\nbold text");
    const json = (await buildArtifact("json", JSON_REPLY, "Payload"))!;
    expect(JSON.parse(json.preview!).users).toHaveLength(2);
    expect(json.filename).toBe("payload.json");
    // Prose still exports as a JSON envelope rather than failing.
    expect(JSON.parse((await buildArtifact("json", PROSE, "Notes"))!.preview!).content).toContain("high-level");
  });

  it("rejects empty content", async () => {
    expect(await buildArtifact("pdf", "   ", "Nothing")).toBeNull();
  });

  it("names files predictably", () => {
    expect(exportFilename("pdf", "My First Report!")).toBe("my-first-report.pdf");
    expect(exportFilename("markdown", "  ")).toBe("matrix-response.md");
    expect(toPlainText("[Link](https://example.org) and `code`")).toBe("Link and code");
  });
});

describe("zip writer", () => {
  it("produces verifiable stored entries", () => {
    const archive = zipStore([{ name: "a/hello.txt", data: "Hello MATRIX" }], new Date("2026-01-02T03:04:05Z"));
    const entries = zipEntries(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("a/hello.txt");
    expect(new TextDecoder().decode(zipRead(archive, "a/hello.txt")!)).toBe("Hello MATRIX");
    expect(entries[0].crc).toBe(crc32(new TextEncoder().encode("Hello MATRIX")));
    // The end-of-central-directory record must close the archive.
    const view = new DataView(archive.buffer);
    expect(view.getUint32(archive.length - 22, true)).toBe(0x06054b50);
  });

  it("computes the reference CRC-32 value", () => {
    expect(crc32(new TextEncoder().encode("123456789")).toString(16)).toBe("cbf43926");
  });

  it("keeps offsets correct for several entries", () => {
    const archive = zipStore([
      { name: "one.txt", data: "1" },
      { name: "two.txt", data: "22" },
      { name: "three/three.txt", data: "333" },
    ]);
    expect(zipEntries(archive).map((entry) => entry.name)).toEqual(["one.txt", "two.txt", "three/three.txt"]);
    expect(new TextDecoder().decode(zipRead(archive, "three/three.txt")!)).toBe("333");
  });

  it("docx and xlsx archives are readable end to end", () => {
    expect(zipRead(exportDocxBytes("# hi", "T"), "word/document.xml")).not.toBeNull();
    expect(zipRead(exportXlsxBytes([["a", "1"]]), "xl/worksheets/sheet1.xml")).not.toBeNull();
  });
});
