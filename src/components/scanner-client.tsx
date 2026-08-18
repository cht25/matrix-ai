"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Button, Card, Spinner } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { riskColor } from "@/lib/utils";
import { env } from "@/lib/env";

const MAX_SIZE = 8 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];

type ScanResult = {
  risk_level?: string;
  confidence?: number;
  reply?: string;
  error?: string;
};

export function ScannerClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  async function handleFile(file: File | undefined | null) {
    if (!file) return;
    setError(null);
    setResult(null);

    // Client-side validation (server + edge re-validate).
    if (!ALLOWED.includes(file.type)) return setError("Only PNG, JPEG and WebP images are supported.");
    if (file.size > MAX_SIZE) return setError("File is too large (max 8 MB).");
    if (file.size < 64) return setError("This file looks too small to be a real screenshot.");

    setBusy(true);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const path = `${user.id}/${crypto.randomUUID()}.${file.type.split("/")[1] === "jpeg" ? "jpg" : file.type.split("/")[1]}`;
      const { error: upErr } = await supabase.storage.from("security-screenshots").upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (upErr) throw new Error("Upload failed: " + upErr.message);

      // Demo mode: no AI gateway — show a clearly-labelled preview instead.
      if (env.demoMode) {
        setResult({
          risk_level: "high",
          confidence: 0.85,
          reply:
            "**Risk: High**  \n**Confidence: 85%**  \n\n**What I noticed:** This screenshot contains classic scam markers — urgency, a request for a one-time code, and a lookalike sender address.\n\n**Why it matters:** These patterns are how account takeovers start.\n\n**What to do now:** Don't reply or click. Tell a trusted adult and report it.\n\n_⚠️ Demo preview — real analysis runs when the AI gateway is deployed with GROQ_API_KEY._",
        });
        setBusy(false);
        return;
      }

      const { data, error: invErr } = await supabase.functions.invoke("ai-gateway", {
        body: { action: "scan", storage_path: path },
      });
      if (invErr || (data as ScanResult | null)?.error) {
        const code = (data as ScanResult | null)?.error;
        if (code === "AI_GATEWAY_NOT_CONFIGURED") {
          setError("The AI gateway isn't deployed yet. Deploy the Supabase Edge Functions and set GROQ_API_KEY (see the README).");
        } else if (code === "RATE_LIMITED_MINUTE" || code === "RATE_LIMITED_DAY") {
          setError("You've scanned several images in a row. Take a short break and try again.");
        } else {
          setError("Analysis failed. Try a different image.");
        }
        return;
      }
      setResult(data as ScanResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFile(e.dataTransfer.files?.[0]); }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Upload a screenshot to analyse"
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
          dragOver ? "border-brand-500 bg-brand-50" : "border-slate-300 bg-white hover:border-brand-400 hover:bg-slate-50"
        }`}
      >
        <span className="text-4xl" aria-hidden="true">📸</span>
        <p className="mt-3 font-semibold text-slate-700">Drop a screenshot here, or click to choose one</p>
        <p className="mt-1 text-sm text-slate-500">PNG, JPEG or WebP · max 8 MB · stored privately</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
      </div>

      {busy ? (
        <Card className="flex items-center gap-3 text-slate-600">
          <Spinner /> Analysing your screenshot… (files are validated, and the AI is told never to repeat personal details)
        </Card>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {result?.reply ? (
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${riskColor(result.risk_level ?? "unknown")}`}>
              {result.risk_level ?? "unknown"} risk
            </span>
            {typeof result.confidence === "number" ? (
              <span className="text-xs text-slate-400">{Math.round(result.confidence * 100)}% confidence</span>
            ) : null}
          </div>
          <Markdown text={result.reply} />
        </Card>
      ) : null}
    </div>
  );
}
