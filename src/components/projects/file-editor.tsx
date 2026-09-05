"use client";

import { useState } from "react";
import { detectEditorIssues } from "@/lib/projects/preview";
import { rpc, RpcCallError } from "@/lib/client/api";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { languageForPath } from "@/lib/ai/agent";

export function FileEditor({
  path,
  value,
  onChange,
  disabled,
}: {
  path: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const lines = Math.max(1, value.split("\n").length);
  const issues = detectEditorIssues(path, value);
  const [copied, setCopied] = useState(false);
  const [pub, setPub] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  }

  async function makePublic() {
    try {
      const r = await rpc<{ public_url: string }>("snippet_publish", {
        lang: languageForPath(path),
        code: value,
        title: path,
      });
      setPub(r.public_url);
    } catch (err) {
      setPub(friendly(err, "Publish failed"));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-9 shrink-0 items-center justify-end gap-1 border-b border-border px-2">
        <button type="button" onClick={() => void copy()} className="rounded-md px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2">{copied ? "Copied" : "Copy"}</button>
        <button type="button" onClick={() => void makePublic()} className="rounded-md px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2">Make public</button>
        {pub ? (pub.startsWith("http") ? <a href={pub} target="_blank" rel="noreferrer" className="truncate text-[11px] text-accent">{pub}</a> : <span className="text-[11px] text-danger">{pub}</span>) : null}
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <pre className="no-scrollbar w-10 shrink-0 overflow-hidden bg-[#05070f] py-3 text-right font-mono text-[11px] leading-relaxed text-ink-3">
          {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
        </pre>
        <textarea
          value={value}
          disabled={disabled}
          spellCheck={false}
          aria-label={`Edit ${path}`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Tab") return;
            e.preventDefault();
            const el = e.currentTarget;
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const next = `${value.slice(0, start)}  ${value.slice(end)}`;
            onChange(next);
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = start + 2;
            });
          }}
          className="min-h-0 flex-1 resize-none border-0 bg-[#05070f] p-3 font-mono text-[12px] leading-relaxed text-[#dbe6ff] outline-none"
        />
      </div>
      {issues.length ? (
        <div className="border-t border-warning/30 bg-warning-soft px-3 py-2 text-[11px] text-warning">
          {issues.map((issue) => <p key={issue}>{issue}</p>)}
        </div>
      ) : null}
    </div>
  );
}

/** Internal code -> human sentence. The raw code stays in the console only. */
function friendly(err: unknown, fallback: string): string {
  const view = mapAdminError(errorCodeOf(err, fallback));
  console.error("[MATRIX]", view.code, err);
  return `${view.title} — ${view.detail}`;
}
