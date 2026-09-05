import { describe, expect, it } from "vitest";
import {
  buildArtifact, exportCsv, exportDocxBytes, exportFilename, exportPdfBytes, exportXlsxBytes,
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
  it("builds a real PDF for prose", () => {
    const built = buildArtifact("pdf", PROSE, "About Python");
    expect(built).not.toBeNull();
    expect(built!.filename).toBe("about-python.pdf");
    expect(built!.mime).toBe("application/pdf");
    const bytes = built!.data as Uint8Array;
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("(About Python) Tj");
    expect(text).toContain("programming language");
  });

  it("paginates long PDFs and keeps the xref table honest", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a very long report that must span several pages.`).join("\n");
    const bytes = exportPdfBytes(long, "Long report");
    const text = new TextDecoder().decode(bytes);
    const pageCount = (text.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);

    // Every xref offset must point at the start of its object.
    const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = text.slice(startxref).match(/(\d{10}) 00000 n /g) ?? [];
    expect(entries.length).toBeGreaterThan(3);
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });

  it("breaks lines instead of printing one long run", () => {
    const text = new TextDecoder().decode(exportPdfBytes("word ".repeat(300), "Wrapped"));
    expect((text.match(/T\*/g) ?? []).length).toBeGreaterThan(5);
  });

  it("builds a zipped DOCX package", () => {
    const built = buildArtifact("docx", `# Title\n\nSome **bold** text.\n\n- one\n- two\n\n\`\`\`py\nprint(1)\n\`\`\``, "Field Notes");
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

  it("builds a real XLSX workbook from a table", () => {
    const built = buildArtifact("xlsx", TABLE, "Users");
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

  it("never builds a spreadsheet out of prose", () => {
    expect(buildArtifact("csv", PROSE)).toBeNull();
    expect(buildArtifact("xlsx", PROSE)).toBeNull();
  });

  it("builds CSV only from tabular data", () => {
    const built = buildArtifact("csv", TABLE, "Users");
    expect(built!.filename).toBe("users.csv");
    expect(built!.mime).toBe("text/csv;charset=utf-8");
    expect(built!.preview).toContain("Name,Age,City");
  });

  it("builds markdown, txt and json", () => {
    expect(buildArtifact("markdown", PROSE, "Python")!.preview).toBe(`# Python\n\n${PROSE}\n`);
    expect(buildArtifact("txt", "# Heading\n\n**bold** text", "Doc")!.preview).toBe("Heading\n\nbold text");
    const json = buildArtifact("json", JSON_REPLY, "Payload")!;
    expect(JSON.parse(json.preview!).users).toHaveLength(2);
    expect(json.filename).toBe("payload.json");
    // Prose still exports as a JSON envelope rather than failing.
    expect(JSON.parse(buildArtifact("json", PROSE, "Notes")!.preview!).content).toContain("high-level");
  });

  it("rejects empty content", () => {
    expect(buildArtifact("pdf", "   ", "Nothing")).toBeNull();
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
