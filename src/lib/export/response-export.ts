export type ExportFormat = "pdf" | "docx" | "markdown" | "txt" | "json";

export function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?|```/g, ""))
    .replace(/[#*_`]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

export function exportMarkdown(content: string, title = "MATRIX response"): string {
  return `# ${title}\n\n${content.trim()}\n`;
}

export function exportJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

/** Minimal PDF 1.4 with one Helvetica page of wrapped text. */
export function exportPdfBytes(text: string, title = "MATRIX"): Uint8Array {
  const lines = wrapLines(toPlainText(text), 90).slice(0, 60);
  const escaped = lines.map((line) => line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")).join("\\n");
  const stream = `BT /F1 11 Tf 48 780 Td 14 TL (${title}) Tj T* /F1 10 Tf (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = body.length;
  let xrefTable = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xrefTable += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `${xrefTable}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

export function exportDocxBytes(markdown: string, title = "MATRIX response"): Uint8Array {
  const paragraphs = markdown.split(/\n+/).map((line) => {
    const safe = escapeXml(line.replace(/^#+\s*/, ""));
    const heading = /^#+\s/.test(line);
    return `<w:p><w:r><w:rPr>${heading ? "<w:b/>" : ""}</w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
  }).join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:p><w:r><w:t>${escapeXml(title)}</w:t></w:r></w:p></w:body></w:document>`;
  // A full ZIP is required for DOCX; callers that cannot zip still get XML they can save.
  return new TextEncoder().encode(documentXml);
}

function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n/)) {
    let line = raw;
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
    out.push(line);
  }
  return out;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
