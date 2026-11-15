"use client";

// LaTeX / math rendering for assistant replies.
//
// KaTeX (~270 kB) is imported lazily, once, the first time a formula appears.
// Until it arrives — and on the server — the TeX source is shown as plain
// text, so nothing is hidden and nothing blocks the first paint.
//
// The HTML set below is produced by KaTeX from the TeX string with
// `trust: false` (no \href, no \includegraphics, no raw HTML). It is never the
// model's own markup.

import { memo, useEffect, useState } from "react";

type Katex = typeof import("katex").default;

let loaded: Katex | null = null;
let loading: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  loading ??= import("@/lib/katex-runtime").then((module) => {
    loaded = module.default;
    return module.default;
  });
  return loading;
}

function toHtml(katex: Katex, tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
      maxExpand: 500,
      maxSize: 20,
    });
  } catch {
    return "";
  }
}

export const MathView = memo(function MathView({ tex, display = false }: { tex: string; display?: boolean }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let alive = true;
    if (loaded) {
      setHtml(toHtml(loaded, tex, display));
      return;
    }
    loadKatex()
      .then((katex) => { if (alive) setHtml(toHtml(katex, tex, display)); })
      .catch(() => { /* the readable TeX source stays on screen */ });
    return () => { alive = false; };
  }, [tex, display]);

  if (display) {
    return html
      ? <div className="math-block" role="math" aria-label={tex} dangerouslySetInnerHTML={{ __html: html }} />
      : <pre className="math-block math-source" aria-label="LaTeX expression">{tex}</pre>;
  }
  return html
    ? <span className="math-inline" role="math" aria-label={tex} dangerouslySetInnerHTML={{ __html: html }} />
    : <code className="math-source">{tex}</code>;
});
