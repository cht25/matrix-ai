"use client";

import { detectEditorIssues } from "@/lib/projects/preview";

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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
