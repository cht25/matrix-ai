"use client";

import type { PipelineEvent } from "@/lib/ai/pipeline";

export function ExecutionConsole({ events }: { events: PipelineEvent[] }) {
  return (
    <div className="exec-console overflow-hidden rounded-xl border border-border bg-[#070B14]">
      <p className="border-b border-white/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9CA3AF]">Live execution console</p>
      <ol className="max-h-48 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-[#9CA3AF]">
        {events.length === 0 ? <li className="text-white/30">Awaiting pipeline…</li> : null}
        {events.map((ev, i) => (
          <li key={`${ev.at}-${i}`} className={ev.type === "error" ? "text-danger" : ev.type === "complete" ? "text-[#00FFA3]" : ""}>
            <span className="text-white/35">{new Date(ev.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            {"  "}
            <span className="text-[#8B5CF6]">{ev.type}</span>
            {"  "}
            {ev.message}
            {ev.tool ? `  ·  ${ev.tool}` : ""}
            {typeof ev.durationMs === "number" ? `  (${ev.durationMs}ms)` : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}
