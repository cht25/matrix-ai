"use client";

import { useState } from "react";
import { Check, Copy, FileCode2, FileJson, FileText, FileType2, Braces } from "lucide-react";
import { exportDocxBytes, exportJson, exportMarkdown, exportPdfBytes, toPlainText } from "@/lib/export/response-export";
import { cn } from "@/lib/utils";

function download(filename: string, data: BlobPart, mime: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const BTN =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function ExportDesk({ content, title = "MATRIX response" }: { content: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  if (!content.trim()) return null;

  const items = [
    {
      key: "pdf", label: "PDF", Icon: FileText,
      run: () => download("matrix-response.pdf", exportPdfBytes(content, title) as BlobPart, "application/pdf"),
    },
    {
      key: "docx", label: "DOCX", Icon: FileType2,
      run: () => download("matrix-response.docx", exportDocxBytes(content, title) as BlobPart, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    },
    {
      key: "md", label: "MD", Icon: FileCode2,
      run: () => download("matrix-response.md", exportMarkdown(content, title), "text/markdown"),
    },
    {
      key: "txt", label: "TXT", Icon: Braces,
      run: () => download("matrix-response.txt", toPlainText(content), "text/plain"),
    },
    {
      key: "json", label: "JSON", Icon: FileJson,
      run: () => download("matrix-response.json", exportJson({ title, content, exported_at: new Date().toISOString() }), "application/json"),
    },
  ];

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">Export</span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Export this response">
        {items.map(({ key, label, Icon, run }) => (
          <button key={key} type="button" className={BTN} onClick={run} aria-label={`Download as ${label}`} title={`Download as ${label}`}>
            <Icon aria-hidden className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
        <button
          type="button"
          className={cn(BTN, copied && "border-success/40 bg-success-soft text-success")}
          aria-label="Copy response to clipboard"
          onClick={() => {
            void navigator.clipboard.writeText(content).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
