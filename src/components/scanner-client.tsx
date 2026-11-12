"use client";

// Screenshot & Image Analyser (spec §29): upload, drag & drop, or paste an
// image. Assets upload privately to Cloudinary via a server-signed grant, then
// MATRIX analyses them with the configured vision model (Gemini by default).
//
// Real analysis only: failures render "Server problem" / category-aware cards
// with [Retry] — never a fabricated finding.

import { useEffect, useRef, useState } from "react";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import { uploadOwnedFile } from "@/lib/client/api";
import { notifyWorkDone } from "@/lib/client/work-notifications";
import { ImageIcon, Sparkles, X } from "lucide-react";
import { Button, Card, Field, Input, Spinner } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { ServerProblem } from "@/components/server-problem";
import { useToast } from "@/components/toast";
import { classifyGatewayResponse, classifyRequestException, failureCopy, type ApiFailure } from "@/lib/api-errors";
import { riskColor } from "@/lib/utils";

const MAX_SIZE = 8 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
const SOURCES = ["SMS", "Email", "Website", "Social Media", "Payment Request", "Login Page", "General Image"];
const SCAN_TIMEOUT_MS = 45_000;

type ScanResult = { risk_level?: string; confidence?: number; reply?: string; error?: string };

export function ScannerClient() {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [source, setSource] = useState<string>("SMS");
  const [customPrompt, setCustomPrompt] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const pendingFile = useRef<File | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

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
      setFailure({ ...failureCopy("invalid-request"), title: "Upload failed", detail: "This file looks too small to be a real image.", retryable: false });
      return;
    }

    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setFileName(file.name);

    if (!firebaseBrowserConfigured) {
      setFailure({ ...failureCopy("not-configured"), detail: "The MATRIX backend is not configured on this deployment yet, so screenshots cannot be analysed." });
      return;
    }

    await runAnalysis(file);
  }

  async function runAnalysis(file: File | null = pendingFile.current) {
    if (!file) return;
    setBusy(true);
    setFailure(null);
    setResult(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("Scan timed out.", "TimeoutError")), SCAN_TIMEOUT_MS);
    try {
      if (!fbAuth().currentUser) {
        setFailure(failureCopy("auth"));
        return;
      }
      const path = await uploadOwnedFile("security-screenshots", file);
      if (!path) {
        setFailure({ ...failureCopy("server"), title: "Upload failed", detail: "The image could not be uploaded to Cloudinary. Please try again." });
        return;
      }

      const promptToUse =
        customPrompt.trim() ||
        (source === "General Image" ? "Describe and analyse everything important in this image clearly and accurately." : "");

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "scan",
          storage_path: path,
          source,
          ...(promptToUse ? { prompt: promptToUse } : {}),
        }),
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
      toast("Image analysis complete.");
      void notifyWorkDone({
        title: "MATRIX image analysis complete",
        body: data.risk_level && data.risk_level !== "unknown"
          ? `Result: ${data.risk_level} risk (${source})`
          : `Finished analysing ${file.name}.`,
        link: "/scanner",
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setFailure(classifyRequestException(err));
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }

  function retry() {
    setFailure(null);
    void runAnalysis(pendingFile.current);
  }

  function clearImage() {
    pendingFile.current = null;
    setResult(null);
    setFailure(null);
    setFileName("");
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  return (
    <div className="space-y-4">
      {/* Source chips */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Where does this image come from?">
        {SOURCES.map((s) => (
          <button
            key={s}
            type="button"
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

      {/* Optional custom question */}
      <Field
        label="Optional question (leave blank for full security scan)"
        htmlFor="scanner-prompt"
        hint="Ask anything specific about the image, or leave empty for an 8-point scam & phishing check."
      >
        <div className="flex gap-2">
          <Input
            id="scanner-prompt"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={source === "General Image" ? "e.g. Explain this diagram / extract the key points" : "e.g. Is this sender address forged?"}
            maxLength={600}
          />
          {pendingFile.current ? (
            <Button type="button" onClick={() => void runAnalysis()} disabled={busy}>
              <Sparkles size={14} /> Re-analyse
            </Button>
          ) : null}
        </div>
      </Field>

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
        aria-label="Upload, drop or paste an image to analyse"
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center transition-colors ${
          dragOver ? "border-accent bg-accent-soft" : "border-border-strong bg-surface hover:border-accent"
        }`}
      >
        <span className="text-ink-3" aria-hidden="true"><ImageIcon size={28} strokeWidth={1.2} /></span>
        <p className="mt-3 font-semibold text-ink">Drop an image or screenshot here, click to choose one, or paste from clipboard</p>
        <p className="mt-1 text-sm text-ink-3">PNG, JPEG or WebP · max 8 MB · stored privately on Cloudinary</p>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void handleFile(e.target.files?.[0])} />
      </div>

      {previewUrl ? (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Uploaded preview" className="h-16 w-16 rounded-lg border border-border object-cover" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{fileName || "Uploaded image"}</p>
              <p className="text-xs text-ink-3">Private Cloudinary asset · Source: {source}</p>
            </div>
          </div>
          <Button type="button" variant="ghost" onClick={clearImage} disabled={busy}>
            <X size={14} /> Clear
          </Button>
        </Card>
      ) : null}

      {busy ? (
        <div role="status" aria-label="MATRIX is analysing your image">
          <Card className="flex items-center gap-3 text-ink-2">
            <Spinner /> MATRIX is responding — analysing your {source.toLowerCase()} image…
          </Card>
        </div>
      ) : null}
      {failure ? (
        <ServerProblem failure={failure} onRetry={failure.retryable ? retry : undefined} onDismiss={() => setFailure(null)} />
      ) : null}

      {result?.reply ? (
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {source !== "General Image" && !customPrompt.trim() ? (
              <>
                <span className={`rounded-md border px-2.5 py-0.5 text-xs font-medium capitalize ${riskColor(result.risk_level ?? "unknown")}`}>
                  {result.risk_level ?? "unknown"} risk
                </span>
                {typeof result.confidence === "number" && result.confidence > 0 ? (
                  <span className="text-xs text-ink-3">{Math.round(result.confidence * 100)}% confidence</span>
                ) : null}
              </>
            ) : (
              <span className="rounded-md border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
                Vision analysis
              </span>
            )}
            <span className="text-xs text-ink-3">· {source}</span>
          </div>
          <Markdown text={result.reply} />
          <p className="mt-4 border-t border-border pt-3 text-xs text-ink-3">
            MATRIX never claims 100% certainty from an image alone. When in doubt about suspicious content, involve a trusted adult.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
