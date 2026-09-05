"use client";

import { useState } from "react";
import { exportDocxBytes, exportJson, exportMarkdown, exportPdfBytes, toPlainText } from "@/lib/export/response-export";

function download(filename: string, data: BlobPart, mime: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportDesk({ content, title = "MATRIX response" }: { content: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  if (!content.trim()) return null;

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface p-3">
      <p className="eyebrow mb-2">Export response</p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className="export-btn" onClick={() => download("matrix-response.pdf", exportPdfBytes(content, title) as BlobPart, "application/pdf")}>PDF</button>
        <button type="button" className="export-btn" onClick={() => download("matrix-response.docx", exportDocxBytes(content, title) as BlobPart, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}>DOCX</button>
        <button type="button" className="export-btn" onClick={() => download("matrix-response.md", exportMarkdown(content, title), "text/markdown")}>Markdown</button>
        <button type="button" className="export-btn" onClick={() => download("matrix-response.txt", toPlainText(content), "text/plain")}>TXT</button>
        <button type="button" className="export-btn" onClick={() => download("matrix-response.json", exportJson({ title, content, exported_at: new Date().toISOString() }), "application/json")}>JSON</button>
        <button
          type="button"
          className="export-btn"
          onClick={() => {
            void navigator.clipboard.writeText(content).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
