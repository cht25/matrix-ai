// Minimal, safe renderer for AI replies (bold, lists, paragraphs).
// Plain text only — no raw HTML ever reaches the DOM.

type Block =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "h"; text: string };

function parseBlocks(raw: string): Block[] {
  const lines = raw.split("\n");
  const blocks: Block[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (list) {
      blocks.push(list.ordered ? { type: "ol", items: list.items } : { type: "ul", items: list.items });
      list = null;
    }
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) { flushList(); continue; }
    const ul = t.match(/^[-*•]\s+(.*)/);
    const ol = t.match(/^\d+[.)]\s+(.*)/);
    if (ul || ol) {
      if (!list || list.ordered !== Boolean(ol)) { flushList(); list = { ordered: Boolean(ol), items: [] }; }
      list.items.push((ul ? ul[1] : ol![1]).trim());
      continue;
    }
    flushList();
    if (/^#{1,3}\s/.test(t)) {
      blocks.push({ type: "h", text: t.replace(/^#{1,3}\s/, "") });
    } else {
      blocks.push({ type: "p", text: t });
    }
  }
  flushList();
  return blocks;
}

function InlineText({ text }: { text: string }) {
  // Bold **...** segments; everything else stays plain text.
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="ai-reply text-[15px] leading-relaxed text-slate-700">
      {blocks.map((b, i) => {
        if (b.type === "h") return <p key={i} className="!mt-3 font-bold text-slate-900"><InlineText text={b.text} /></p>;
        if (b.type === "ul") return <ul key={i}>{b.items.map((it, j) => <li key={j}><InlineText text={it} /></li>)}</ul>;
        if (b.type === "ol") return <ol key={i}>{b.items.map((it, j) => <li key={j}><InlineText text={it} /></li>)}</ol>;
        return <p key={i}><InlineText text={b.text} /></p>;
      })}
    </div>
  );
}
