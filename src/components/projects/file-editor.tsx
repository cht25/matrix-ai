"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  undoDepth,
  redoDepth,
} from "@codemirror/commands";
import {
  foldGutter,
  foldKeymap,
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { searchKeymap, openSearchPanel, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { Undo2, Redo2, Search, Save, Check, Copy, Globe, AlertTriangle } from "lucide-react";
import { detectEditorIssues } from "@/lib/projects/preview";
import { rpc } from "@/lib/client/api";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { languageForPath } from "@/lib/ai/agent";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

function languageExtensionForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".ts")) return javascript({ typescript: true, jsx: lower.endsWith(".tsx") });
  if (lower.endsWith(".jsx") || lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return javascript({ jsx: lower.endsWith(".jsx") });
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".svg")) return html();
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return css();
  if (lower.endsWith(".json")) return json();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return markdown();
  if (lower.endsWith(".py")) return python();
  return [];
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    backgroundColor: "#05070f",
    color: "#dbe6ff",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono, 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace)",
    lineHeight: "1.6",
  },
  ".cm-gutters": {
    backgroundColor: "#070a14",
    color: "#64748b",
    borderRight: "1px solid rgba(148, 163, 184, 0.14)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(56, 189, 248, 0.08)",
    color: "#bae6fd",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(56, 189, 248, 0.05)",
  },
  ".cm-content": {
    padding: "10px 0",
  },
});

export function FileEditor({
  path,
  value,
  onChange,
  onSave,
  saveStatus = "idle",
  lastSavedAt = null,
  saveError = null,
  disabled,
}: {
  path: string;
  value: string;
  onChange: (next: string) => void;
  onSave?: () => void;
  saveStatus?: SaveStatus;
  lastSavedAt?: string | null;
  saveError?: string | null;
  disabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef<Map<string, EditorState>>(new Map());
  const activePathRef = useRef<string>(path);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const readOnlyCompartment = useRef(new Compartment());

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  const issues = detectEditorIssues(path, value);
  const [copied, setCopied] = useState(false);
  const [pub, setPub] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncHistoryFlags = useCallback((state: EditorState) => {
    setCanUndo(undoDepth(state) > 0);
    setCanRedo(redoDepth(state) > 0);
  }, []);

  const createStateForFile = useCallback((filePath: string, doc: string) => {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        oneDark,
        editorTheme,
        EditorState.tabSize.of(2),
        languageExtensionForPath(filePath),
        readOnlyCompartment.current.of(EditorState.readOnly.of(Boolean(disabled))),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const nextDoc = update.state.doc.toString();
            onChangeRef.current(nextDoc);
          }
          if (update.docChanged || update.selectionSet) {
            statesRef.current.set(activePathRef.current, update.state);
            syncHistoryFlags(update.state);
          }
        }),
      ],
    });
  }, [disabled, syncHistoryFlags]);

  // Mount EditorView once
  useEffect(() => {
    if (!containerRef.current) return;
    const initialState = createStateForFile(path, value);
    statesRef.current.set(path, initialState);
    const view = new EditorView({
      state: initialState,
      parent: containerRef.current,
    });
    viewRef.current = view;
    syncHistoryFlags(initialState);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch file: preserve per-file EditorState (and thus per-file Undo/Redo history)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (activePathRef.current !== path) {
      // Save outgoing file's state
      statesRef.current.set(activePathRef.current, view.state);
      activePathRef.current = path;

      const cached = statesRef.current.get(path);
      const nextState =
        cached && cached.doc.toString() === value
          ? cached
          : createStateForFile(path, value);
      statesRef.current.set(path, nextState);
      view.setState(nextState);
      syncHistoryFlags(nextState);
    } else {
      // Same file, external value update (e.g. restore version / agent edit)
      const currentDoc = view.state.doc.toString();
      if (currentDoc !== value) {
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: value },
        });
      }
    }
  }, [path, value, createStateForFile, syncHistoryFlags]);

  // Update readOnly when disabled changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(Boolean(disabled))),
    });
  }, [disabled]);

  function handleUndo() {
    const view = viewRef.current;
    if (!view) return;
    undo(view);
    view.focus();
    syncHistoryFlags(view.state);
  }

  function handleRedo() {
    const view = viewRef.current;
    if (!view) return;
    redo(view);
    view.focus();
    syncHistoryFlags(view.state);
  }

  function handleSearch() {
    const view = viewRef.current;
    if (!view) return;
    openSearchPanel(view);
    view.focus();
  }

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
      <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-1 border-b border-border px-2 py-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo || disabled}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none"
          >
            <Undo2 size={13} />
            <span className="hidden sm:inline">Undo</span>
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={!canRedo || disabled}
            title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
            aria-label="Redo"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none"
          >
            <Redo2 size={13} />
            <span className="hidden sm:inline">Redo</span>
          </button>
          <button
            type="button"
            onClick={handleSearch}
            title="Find & Replace (Ctrl+F)"
            aria-label="Find and Replace"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
          >
            <Search size={13} />
            <span className="hidden sm:inline">Find</span>
          </button>
          {onSave ? (
            <button
              type="button"
              onClick={onSave}
              disabled={disabled || saveStatus === "saving"}
              title="Save file (Ctrl+S)"
              aria-label="Save file"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-accent hover:bg-surface-2 disabled:opacity-50"
            >
              <Save size={13} />
              <span>{saveStatus === "saving" ? "Saving…" : "Save"}</span>
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-3" aria-live="polite">
            {saveStatus === "saving" && "Saving…"}
            {saveStatus === "dirty" && "Unsaved changes"}
            {saveStatus === "saved" && (lastSavedAt ? `Saved ${lastSavedAt}` : "Saved")}
            {saveStatus === "error" && (
              <span className="inline-flex items-center gap-1 text-danger">
                <AlertTriangle size={12} />
                {saveError ?? "Save failed"}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
          <button
            type="button"
            onClick={() => void makePublic()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
          >
            <Globe size={12} />
            <span className="hidden sm:inline">Make public</span>
          </button>
          {pub ? (
            pub.startsWith("http") ? (
              <a href={pub} target="_blank" rel="noreferrer" className="max-w-[140px] truncate text-[11px] text-accent">
                {pub}
              </a>
            ) : (
              <span className="text-[11px] text-danger">{pub}</span>
            )
          ) : null}
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-[#05070f]" aria-label={`Edit ${path}`} />

      {issues.length ? (
        <div className="border-t border-warning/30 bg-warning-soft px-3 py-2 text-[11px] text-warning">
          {issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Internal code -> human sentence. The raw code stays in the console only. */
function friendly(err: unknown, fallback: string): string {
  const view = mapAdminError(errorCodeOf(err, fallback));
  console.error("[QORVYNA]", view.code, err);
  return `${view.title} — ${view.detail}`;
}
