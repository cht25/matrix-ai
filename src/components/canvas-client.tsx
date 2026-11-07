"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, Code2, Download, Expand, FileText, GitBranch, History, ImagePlus, Link2, Minus, Plus, Save, Sparkles, Trash2, Type, Upload } from "lucide-react";
import { Alert, Badge, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { rpc, RpcCallError } from "@/lib/client/api";
import { EMPTY_CANVAS, type CanvasNode, type CanvasRecord, type CanvasSummary } from "@/lib/canvas";

type Project = { id: string; title: string };
type Version = { id: string; title: string; revision: number; created_at: string };
type Gesture = { kind: "move" | "resize" | "pan"; id?: string; x: number; y: number; originalX: number; originalY: number };

export function CanvasClient({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const canvasId = params.get("canvas");
  const [items, setItems] = useState<CanvasSummary[]>([]);
  const [record, setRecord] = useState<CanvasRecord | null>(null);
  const recordRef = useRef<CanvasRecord | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [connectFrom, setConnectFrom] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const dirty = useRef(false);
  const conflict = useRef(false);
  const saving = useRef(false);
  const queued = useRef(false);
  const sequence = useRef(0);
  const gesture = useRef<Gesture | null>(null);

  const load = useCallback(async (id: string) => {
    setError(""); setBusy(true); conflict.current = false; dirty.current = false;
    try {
      const result = await rpc<CanvasRecord>("canvas_get", { id });
      recordRef.current = result; setRecord(result); setSelectedId(""); setVersions(null); setSaveState("saved");
    } catch { setError("This canvas could not be opened. It may have been removed or belong to another account."); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    void rpc<CanvasSummary[]>("canvas_list").then(setItems).catch(() => setError("Could not load your canvases."));
  }, []);
  useEffect(() => {
    if (canvasId) void load(canvasId);
    else { recordRef.current = null; setRecord(null); }
  }, [canvasId, load]);

  const persist = useCallback(async (): Promise<boolean> => {
    const current = recordRef.current;
    if (!current || !dirty.current || conflict.current) return !dirty.current;
    if (saving.current) { queued.current = true; return false; }
    saving.current = true;
    const savedSequence = sequence.current;
    setSaveState("saving");
    try {
      const result = await rpc<CanvasRecord>("canvas_save", { id: current.id, revision: current.revision, title: current.title, project_id: current.project_id, document: current.document });
      const latest = recordRef.current!;
      recordRef.current = { ...latest, revision: result.revision, updated_at: result.updated_at };
      dirty.current = sequence.current !== savedSequence;
      setRecord(recordRef.current);
      setSaveState(dirty.current ? "dirty" : "saved");
      setError("");
      return !dirty.current;
    } catch (err) {
      setSaveState("error");
      if (err instanceof RpcCallError && err.code === "CANVAS_REVISION_CONFLICT") {
        conflict.current = true;
        setError("Another tab saved a newer revision. Autosave is paused to protect it. Export your draft, then reload the saved canvas.");
      } else setError("Autosave failed. Your draft is still here; retry when the connection is available.");
      return false;
    } finally {
      saving.current = false;
      if (queued.current) { queued.current = false; if (dirty.current && !conflict.current) void persist(); }
    }
  }, []);

  useEffect(() => {
    if (!record || !dirty.current || conflict.current) return;
    const timer = window.setTimeout(() => void persist(), 700);
    return () => window.clearTimeout(timer);
  }, [record, persist]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ""; } };
    const flush = () => { if (document.visibilityState === "hidden") void persist(); };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("visibilitychange", flush);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("visibilitychange", flush); };
  }, [persist]);

  function change(update: (current: CanvasRecord) => CanvasRecord) {
    if (!recordRef.current || conflict.current) return;
    sequence.current += 1; dirty.current = true;
    const next = update(recordRef.current);
    recordRef.current = next; setRecord(next); setSaveState("dirty");
  }
  function patchNode(id: string, patch: Partial<CanvasNode>) {
    change((current) => ({ ...current, document: { ...current.document, nodes: current.document.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) } }));
  }
  function open(id: string) {
    if (dirty.current && !confirm("Leave this draft? Unsaved changes will be lost.")) return;
    router.push(`/canvas?canvas=${encodeURIComponent(id)}`);
  }
  async function create() {
    if (dirty.current && !(await persist())) return;
    setBusy(true);
    try { const result = await rpc<CanvasRecord>("canvas_create", { title: "Untitled canvas" }); setItems((current) => [result, ...current]); router.push(`/canvas?canvas=${result.id}`); }
    catch { setError("Could not create the canvas. No document was saved."); }
    finally { setBusy(false); }
  }
  function addNode(type: CanvasNode["type"]) {
    if (!record || record.document.nodes.length >= 100) return;
    const id = crypto.randomUUID();
    const node: CanvasNode = { id, type, x: 60 + (record.document.nodes.length % 5) * 36, y: 60 + (record.document.nodes.length % 5) * 36, width: type === "rectangle" || type === "ellipse" || type === "diamond" ? 180 : 320, height: type === "code" ? 260 : type === "image" ? 240 : 180, content: type === "rectangle" || type === "ellipse" || type === "diamond" ? "New step" : "", color: type === "diamond" ? "#34d399" : "#3897ff" };
    change((current) => ({ ...current, document: { ...current.document, nodes: [...current.document.nodes, node] } }));
    setSelectedId(id);
  }
  function selectNode(id: string) {
    if (connectFrom && connectFrom !== id) {
      const edge = { id: crypto.randomUUID(), from: connectFrom, to: id, label: "" };
      change((current) => ({ ...current, document: { ...current.document, edges: [...current.document.edges, edge].slice(0, 200) } }));
      setConnectFrom("");
    }
    setSelectedId(id);
  }
  function removeNode() {
    if (!selectedId) return;
    change((current) => ({ ...current, document: { ...current.document, nodes: current.document.nodes.filter((node) => node.id !== selectedId), edges: current.document.edges.filter((edge) => edge.from !== selectedId && edge.to !== selectedId) } }));
    setSelectedId("");
  }
  function pointerDown(event: ReactPointerEvent, kind: Gesture["kind"], node?: CanvasNode) {
    if (conflict.current) return;
    event.stopPropagation(); event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const viewport = recordRef.current!.document.viewport;
    gesture.current = { kind, id: node?.id, x: event.clientX, y: event.clientY, originalX: kind === "resize" ? node!.width : kind === "move" ? node!.x : viewport.x, originalY: kind === "resize" ? node!.height : kind === "move" ? node!.y : viewport.y };
  }
  function pointerMove(event: ReactPointerEvent) {
    const active = gesture.current;
    if (!active || !recordRef.current) return;
    const zoom = recordRef.current.document.viewport.zoom;
    const dx = (event.clientX - active.x) / zoom, dy = (event.clientY - active.y) / zoom;
    if (active.kind === "pan") {
      change((current) => ({ ...current, document: { ...current.document, viewport: { ...current.document.viewport, x: Math.max(-100000, Math.min(100000, active.originalX + dx * zoom)), y: Math.max(-100000, Math.min(100000, active.originalY + dy * zoom)) } } }));
    } else if (active.kind === "move") patchNode(active.id!, { x: Math.max(-100000, Math.min(100000, active.originalX + dx)), y: Math.max(-100000, Math.min(100000, active.originalY + dy)) });
    else patchNode(active.id!, { width: Math.max(100, Math.min(2400, active.originalX + dx)), height: Math.max(48, Math.min(2400, active.originalY + dy)) });
  }
  function zoom(delta: number) { change((current) => ({ ...current, document: { ...current.document, viewport: { ...current.document.viewport, zoom: Math.max(0.25, Math.min(2, current.document.viewport.zoom + delta)) } } })); }
  function exportJson() {
    if (!record) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ title: record.title, document: record.document }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${record.title.replace(/[^a-z0-9-]/gi, "-") || "canvas"}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importJson(file: File) {
    if (file.size > 1000000) { setError("Import is limited to 1 MB."); return; }
    setBusy(true);
    try {
      const data = JSON.parse(await file.text());
      const result = await rpc<CanvasRecord>("canvas_import", { title: String(data.title || "Imported canvas").slice(0, 120), document: data.document });
      setItems((current) => [result, ...current]); router.push(`/canvas?canvas=${result.id}`);
    } catch { setError("Import failed. Use a MATRIX canvas JSON export with valid nodes and connections."); }
    finally { setBusy(false); }
  }
  async function snapshot() {
    if (!record || !(await persist())) return;
    setBusy(true);
    try { await rpc("canvas_version_create", { id: record.id }); setVersions(await rpc<Version[]>("canvas_versions", { id: record.id })); }
    catch { setError("Could not save a version. The current canvas is unchanged."); }
    finally { setBusy(false); }
  }
  async function restore(id: string) {
    if (!record || !confirm("Restore this version? Export your current draft first if you need to keep it.")) return;
    setBusy(true);
    try { const result = await rpc<CanvasRecord>("canvas_version_restore", { id: record.id, version_id: id }); dirty.current = false; conflict.current = false; recordRef.current = result; setRecord(result); setSaveState("saved"); }
    catch { setError("Version restoration failed."); }
    finally { setBusy(false); }
  }
  async function draftWithAI() {
    if (!record || !aiPrompt.trim()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ action: "chat", message: `Create content for a visual canvas based on this request. Return only the requested content, without claiming to have modified the canvas:\n${aiPrompt.trim()}`, is_temporary: true, mode: "general", stream: false }) });
      const data = await response.json();
      if (!response.ok || !data.reply) throw new Error(data.error ?? "AI request failed");
      addNode("text");
      const id = recordRef.current!.document.nodes.at(-1)!.id;
      patchNode(id, { content: String(data.reply).slice(0, 40000) });
      setAiPrompt("");
    } catch (err) { setError(`AI draft was not added: ${err instanceof Error ? err.message : "request failed"}.`); }
    finally { setBusy(false); }
  }

  const selected = record?.document.nodes.find((node) => node.id === selectedId);
  const viewport = record?.document.viewport ?? EMPTY_CANVAS.viewport;
  return <div className="flex min-h-0 flex-1 flex-col gap-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="eyebrow text-accent">Think spatially</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">Canvas</h1><p className="mt-1 text-xs text-ink-2">Visual notes, code and connected ideas. Saved to your MATRIX account.</p></div>
      <div className="flex flex-wrap gap-2"><label className={`btn-outline cursor-pointer ${busy ? "pointer-events-none opacity-50" : ""}`}><Upload size={15} /> Import<input type="file" accept="application/json,.json" className="sr-only" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importJson(file); event.target.value = ""; }} /></label><Button onClick={() => void create()} disabled={busy}><Plus size={15} /> New canvas</Button></div>
    </header>
    {error ? <Alert tone="danger">{error}{conflict.current ? <Button variant="outline" className="ml-3" onClick={() => { if (record && confirm("Discard this local draft and reload?")) void load(record.id); }}>Reload saved canvas</Button> : saveState === "error" ? <Button variant="outline" className="ml-3" onClick={() => void persist()}>Retry save</Button> : null}</Alert> : null}
    {items.length > 0 ? <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Saved canvases">{items.map((item) => <button type="button" key={item.id} className={`chip shrink-0 ${item.id === canvasId ? "!border-accent !text-accent" : ""}`} onClick={() => open(item.id)}>{item.title}</button>)}</div> : null}
    {!record ? <Card className="grid min-h-72 place-items-center text-center"><div><GitBranch className="mx-auto text-accent" size={32} /><h2 className="mt-4 text-lg font-semibold">Give your ideas room to grow</h2><p className="mx-auto mt-2 max-w-md text-sm text-ink-2">Create a canvas, add notes or shapes, and connect them. Drag headers to move, use the corner handle to resize, and edit directly on the board.</p><Button className="mt-5" onClick={() => void create()} disabled={busy}>Create your first canvas</Button></div></Card> : <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface p-2">
        <div className="flex flex-wrap gap-1">
          {([{ type: "text", label: "Text", icon: Type }, { type: "code", label: "Code", icon: Code2 }, { type: "image", label: "Image", icon: ImagePlus }, { type: "document", label: "Document", icon: FileText }, { type: "rectangle", label: "Step", icon: Plus }, { type: "diamond", label: "Decision", icon: GitBranch }, { type: "ellipse", label: "Mind map node", icon: Plus }] as const).map(({ type, label, icon: Icon }) => <Button key={type} variant="ghost" onClick={() => addNode(type)} disabled={!!connectFrom || conflict.current}><Icon size={15} /><span className="hidden xl:inline">{label}</span><span className="sr-only xl:hidden">{label}</span></Button>)}
        </div>
        <span role="status" className={`flex items-center gap-1.5 px-2 text-xs ${saveState === "error" ? "text-danger" : "text-ink-2"}`}>{saveState === "saved" ? <Check size={13} className="text-success" /> : <Save size={13} />}{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Unsaved changes"}</span>
      </div>
      <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="canvas-stage relative min-h-[480px] touch-none overflow-hidden rounded-xl border border-border bg-bg" onPointerDown={(event) => { if (event.target === event.currentTarget) pointerDown(event, "pan"); }} onPointerMove={pointerMove} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }} aria-label="Visual canvas board">
          <div className="absolute left-0 top-0" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, transformOrigin: "0 0" }}>
            <svg className="pointer-events-none absolute overflow-visible" width="1" height="1" aria-label="Node connections"><defs><marker id="canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#3897ff" /></marker></defs>{record.document.edges.map((edge) => { const from = record.document.nodes.find((node) => node.id === edge.from)!; const to = record.document.nodes.find((node) => node.id === edge.to)!; return <g key={edge.id}><line x1={from.x + from.width / 2} y1={from.y + from.height / 2} x2={to.x + to.width / 2} y2={to.y + to.height / 2} stroke="#3897ff" strokeWidth="2" markerEnd="url(#canvas-arrow)" /><text x={(from.x + from.width / 2 + to.x + to.width / 2) / 2} y={(from.y + from.height / 2 + to.y + to.height / 2) / 2 - 8} fill="currentColor" fontSize="12" textAnchor="middle">{edge.label}</text></g>; })}</svg>
            {record.document.nodes.map((node) => {
              const shape = ["rectangle", "ellipse", "diamond"].includes(node.type);
              return <div key={node.id} className={`canvas-node absolute flex flex-col overflow-hidden border bg-surface shadow-card ${selectedId === node.id ? "border-accent ring-2 ring-accent/20" : "border-border-strong"}`} style={{ left: node.x, top: node.y, width: node.width, height: node.height, borderRadius: node.type === "ellipse" ? "50%" : 12, borderTopColor: node.color, borderTopWidth: 3 }} onClick={() => selectNode(node.id)}>
                <div className={`flex min-h-8 cursor-grab touch-none items-center justify-between gap-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-ink-3 active:cursor-grabbing ${shape ? "shrink-0" : "border-b border-border"}`} onPointerDown={(event) => pointerDown(event, "move", node)} onPointerMove={pointerMove} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }}><span>{node.type}</span><span className="h-1.5 w-5 rounded-full" style={{ background: node.color }} /></div>
                {node.type === "image" ? node.content ? <img src={node.content} alt="Canvas image" className="min-h-0 flex-1 object-contain p-2" draggable={false} /> : <p className="p-4 text-xs text-ink-3">Select this image and add an HTTPS URL in the inspector.</p> : <textarea aria-label={`${node.type} content`} value={node.content} readOnly={conflict.current} disabled={!!connectFrom} onChange={(event) => patchNode(node.id, { content: event.target.value })} onPointerDown={(event) => event.stopPropagation()} placeholder={node.type === "code" ? "// Write code here" : shape ? "Label" : "Write an idea…"} className={`min-h-0 flex-1 resize-none border-0 bg-transparent p-3 text-sm leading-relaxed outline-none ${node.type === "code" ? "font-mono text-xs" : ""} ${shape ? "text-center" : ""}`} maxLength={40000} />}
                <button type="button" aria-label={`Resize ${node.type}`} className="absolute bottom-0 right-0 grid h-5 w-5 cursor-se-resize touch-none place-items-center text-ink-3" onPointerDown={(event) => pointerDown(event, "resize", node)} onPointerMove={pointerMove} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }}><Expand size={11} /></button>
              </div>;
            })}
          </div>
          {!record.document.nodes.length ? <div className="pointer-events-none absolute inset-0 grid place-items-center px-8 text-center text-sm text-ink-3">Add a text block, code block or shape from the toolbar.</div> : null}
          <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border border-border bg-surface p-1" onPointerDown={(event) => event.stopPropagation()}><Button variant="ghost" aria-label="Zoom out" onClick={() => zoom(-0.1)}><Minus size={14} /></Button><span className="min-w-12 text-center text-xs">{Math.round(viewport.zoom * 100)}%</span><Button variant="ghost" aria-label="Zoom in" onClick={() => zoom(0.1)}><Plus size={14} /></Button><Button variant="ghost" onClick={() => change((current) => ({ ...current, document: { ...current.document, viewport: { x: 40, y: 40, zoom: 1 } } }))}>Reset view</Button></div>
        </div>
        <aside className="space-y-3">
          <Card className="space-y-3 p-4"><Field label="Canvas title" htmlFor="canvas-title"><Input id="canvas-title" value={record.title} disabled={conflict.current} maxLength={120} onChange={(event) => change((current) => ({ ...current, title: event.target.value }))} /></Field><Field label="Linked project" htmlFor="canvas-project"><Select id="canvas-project" value={record.project_id ?? ""} disabled={conflict.current} onChange={(event) => change((current) => ({ ...current, project_id: event.target.value || null }))}><option value="">No linked project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field>{record.project_id ? <Link className="text-xs text-accent" href={`/projects/${record.project_id}`}>Open linked project →</Link> : null}</Card>
          <Card className="space-y-3 p-4"><h2 className="text-sm font-semibold">Selection</h2>{selected ? <><Badge>{selected.type}</Badge>{selected.type === "image" ? <Field label="Image HTTPS URL" htmlFor="image-url"><Input id="image-url" type="url" value={selected.content} onChange={(event) => patchNode(selected.id, { content: event.target.value })} /></Field> : null}<Field label="Accent color" htmlFor="node-color"><input id="node-color" type="color" value={selected.color} onChange={(event) => patchNode(selected.id, { color: event.target.value })} className="h-9 w-full cursor-pointer rounded border border-border bg-surface" /></Field><Button variant="outline" className="w-full" disabled={record.document.edges.length >= 200} onClick={() => setConnectFrom(connectFrom ? "" : selected.id)}><Link2 size={14} />{connectFrom ? "Choose target node…" : "Connect to another node"}</Button>{connectFrom ? <p className="text-xs text-ink-2">Click a different node on the board to create an arrow.</p> : null}<Button variant="danger" className="w-full" onClick={removeNode}><Trash2 size={14} /> Delete block</Button></> : <p className="text-xs leading-relaxed text-ink-2">Select a block to change its color, connect it or delete it. Drag empty space to pan.</p>}</Card>
          <Card className="space-y-3 p-4"><h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={15} className="text-accent" /> Draft with MATRIX</h2><Textarea aria-label="AI canvas prompt" rows={3} value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="Outline a plan for my school website…" maxLength={4000} /><Button variant="secondary" className="w-full" disabled={busy || !aiPrompt.trim() || conflict.current} onClick={() => void draftWithAI()}>{busy ? "Working…" : "Add AI draft as a note"}</Button><p className="text-[11px] text-ink-3">Uses your configured AI provider. The draft is added only after a successful response.</p></Card>
        </aside>
      </div>
      <div className="flex flex-wrap items-center gap-2"><Button variant="outline" onClick={exportJson}><Download size={14} /> Export JSON</Button><Button variant="outline" disabled={busy || saveState === "saving"} onClick={() => void snapshot()}><Save size={14} /> Save version</Button><Button variant="outline" disabled={busy} onClick={() => { if (versions) setVersions(null); else void rpc<Version[]>("canvas_versions", { id: record.id }).then(setVersions).catch(() => setError("Could not load version history.")); }}><History size={14} /> Versions</Button><Button variant="ghost" disabled={busy} onClick={() => { if (confirm("Remove this canvas from your list? Saved versions are retained on the server.")) void rpc("canvas_delete", { id: record.id }).then(() => { dirty.current = false; setItems((current) => current.filter((item) => item.id !== record.id)); router.push("/canvas"); }).catch(() => setError("Could not remove canvas.")); }}><Trash2 size={14} /> Remove</Button><Link href="/chat?mode=agent" className="ml-auto text-xs text-accent">Open Agent <ArrowLeft size={12} className="inline rotate-180" /></Link></div>
      {versions ? <Card className="space-y-2 p-4"><h2 className="text-sm font-semibold">Saved versions</h2>{!versions.length ? <p className="text-xs text-ink-2">No explicit snapshots yet. Autosave keeps the current revision.</p> : versions.map((version) => <div key={version.id} className="flex items-center justify-between gap-3 border-t border-border pt-2"><span className="text-xs text-ink-2">{version.title} · revision {version.revision} · {new Date(version.created_at).toLocaleString()}</span><Button variant="outline" disabled={busy} onClick={() => void restore(version.id)}>Restore</Button></div>)}</Card> : null}
    </>}
  </div>;
}
