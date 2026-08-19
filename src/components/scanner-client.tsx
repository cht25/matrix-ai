"use client";

// Screenshot scanner (spec §29): upload, drag & drop, or paste an image.
// Results show risk, confidence, indicators, actions, what-not-to-do and
// already-interacted guidance. Never claims 100% certainty.
//
// Real analysis only: failures render "Server problem" / category-aware
// cards with [Retry] — never a fabricated finding.

import { useRef, useState } from "react";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import { uploadOwnedFile } from "@/lib/client/api";
import { ImageIcon } from "lucide-react";
import { Button, Card, Spinner } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { ServerProblem } from "@/components/server-problem";
import { classifyGatewayResponse, classifyRequestException, failureCopy, type ApiFailure } from "@/lib/api-errors";
import { riskColor } from "@/lib/utils";

const MAX_SIZE = 8 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
const SOURCES = ["SMS", "Email", "Website", "Social Media", "Payment Request", "Login Page"];
const SCAN_TIMEOUT_MS = 45_000;

type ScanResult = { risk_level?: string; confidence?: number; reply?: string; error?: string };

export function ScannerClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [source, setSource] = useState<string>("SMS");
  const pendingFile = useRef<File | null>(null);

  async function handleFile(file: File | undefined | null) {
    if (!file) return;
    pendingFile.current = file;
    setFailure(null);
    setResult(null);
    if (!ALLOWED.includes(file.type)) {
      setFailure({ ...failureCopy("invalid-request"), title: "Unsupported file", detail: "Only PNG, JPEG and WebP images are supported.", retryable: false });
      return;
    }
    if (file.size > MAX_SIZE) {
      setFailure({ ...failureCopy("invalid-request"), title: "Upload failed", detail: "The image is too large (maximum 8 MB). Choose a smaller screenshot.", retryable: false });
      return;
    }
    if (file.size < 64) {
      setFailure({ ...failureCopy("invalid-request"), title: "Upload failed", detail: "This file looks too small to be a real screenshot.", retryable: false });
      return;
    }
    if (!firebaseBrowserConfigured) {
      setFailure({ ...failureCopy("not-configured"), detail: "The MATRIX backend is not configured on this deployment yet, so screenshots cannot be analysed." });
      return;
    }

    setBusy(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("Scan timed out.", "TimeoutError")), SCAN_TIMEOUT_MS);
    try {
      if (!fbAuth().currentUser) {
        setFailure(failureCopy("auth"));
        return;
      }
      const path = await uploadOwnedFile("security-screenshots", file);
      if (!path) {
        setFailure({ ...failureCopy("server"), title: "Upload failed", detail: "The screenshot could not be uploaded. Please try again." });
        return;
      }

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "scan", storage_path: path }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let code: string | null = null;
        try {
          const body = (await res.json()) as { error?: unknown };
          code = typeof body.error === "string" ? body.error : null;
        } catch {
          code = null;
        }
        setFailure(classifyGatewayResponse(res.status, code));
        return;
      }
      const data = (await res.json()) as ScanResult;
      if (!data.reply || data.error) {
        setFailure(classifyGatewayResponse(502, typeof data.error === "string" ? data.error : null));
        return;
      }
      setResult(data);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setFailure(classifyRequestException(err));
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }

  function retry() {
    setFailure(null);
    void handleFile(pendingFile.current);
  }

  return (
    <div className="space-y-4">
      {/* Source chips */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Where does this screenshot come from?">
        {SOURCES.map((s) => (
          <button
            key={s}
            onClick={() => setSource(s)}
            aria-pressed={source === s}
            className={`min-h-9 rounded-md border px-3.5 py-1.5 text-xs font-medium transition-colors ${
              source === s ? "border-accent bg-accent-soft text-accent" : "border-border-strong bg-surface text-ink-2 hover:border-accent"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Dropzone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFile(e.dataTransfer.files?.[0]); }}
        onPaste={(e) => {
          const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
          const file = item?.getAsFile();
          void handleFile(file);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Upload, drop or paste a screenshot to analyse"
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center transition-colors ${
          dragOver ? "border-accent bg-accent-soft" : "border-border-strong bg-surface hover:border-accent"
        }`}
      >
        <span className="text-ink-3" aria-hidden="true"><ImageIcon size={28} strokeWidth={1.2} /></span>
        <p className="mt-3 font-semibold text-ink">Drop a screenshot here, click to choose one, or paste an image</p>
        <p className="mt-1 text-sm text-ink-3">PNG, JPEG or WebP · max 8 MB · stored privately</p>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void handleFile(e.target.files?.[0])} />
      </div>

      {busy ? (
        <div role="status" aria-label="MATRIX is analysing your screenshot">
          <Card className="flex items-center gap-3 text-ink-2">
            <Spinner /> MATRIX is responding — analysing your {source.toLowerCase()} screenshot…
          </Card>
        </div>
      ) : null}
      {failure ? (
        <ServerProblem failure={failure} onRetry={failure.retryable ? retry : undefined} onDismiss={() => setFailure(null)} />
      ) : null}

      {result?.reply ? (
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className={`rounded-md border px-2.5 py-0.5 text-xs font-medium capitalize ${riskColor(result.risk_level ?? "unknown")}`}>
              {result.risk_level ?? "unknown"} risk
            </span>
            {typeof result.confidence === "number" ? (
              <span className="text-xs text-ink-3">{Math.round(result.confidence * 100)}% confidence</span>
            ) : null}
            <span className="text-xs text-ink-3">· Source: {source}</span>
          </div>
          <Markdown text={result.reply} />
          <p className="mt-4 border-t border-border pt-3 text-xs text-ink-3">
            MATRIX never claims 100% certainty from a screenshot alone. When in doubt, involve a trusted adult.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
