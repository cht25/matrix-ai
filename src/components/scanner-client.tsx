"use client";

// Screenshot scanner (spec §29): upload, drag & drop, or paste an image.
// Results show risk, confidence, indicators, actions, what-not-to-do and
// already-interacted guidance. Never claims 100% certainty.

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Button, Card, Spinner } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { riskColor } from "@/lib/utils";
import { env } from "@/lib/env";

const MAX_SIZE = 8 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
const SOURCES = ["SMS", "Email", "Website", "Social Media", "Payment Request", "Login Page"];

type ScanResult = { risk_level?: string; confidence?: number; reply?: string; error?: string };

export function ScannerClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [source, setSource] = useState<string>("SMS");

  async function handleFile(file: File | undefined | null) {
    if (!file) return;
    setError(null);
    setResult(null);
    if (!ALLOWED.includes(file.type)) return setError("Only PNG, JPEG and WebP images are supported.");
    if (file.size > MAX_SIZE) return setError("File is too large (max 8 MB).");
    if (file.size < 64) return setError("This file looks too small to be a real screenshot.");

    setBusy(true);
    try {
      const supabase = createClient();
      if (env.demoMode) {
        await new Promise((r) => setTimeout(r, 800));
        setResult({
          risk_level: "high",
          confidence: 0.85,
          reply:
            "**Risk: High**  \n**Confidence: 85%**  \n\n**What we found:** Classic scam markers — urgency, a request for a one-time code, and a lookalike sender address.\n\n**Suspicious indicators:**\n- Pressure to act immediately\n- A request for a verification code\n- Sender address that mimics a real company\n\n**Recommended actions:**\n1. Don't reply or click anything.\n2. Tell a trusted adult.\n3. Report it using the verified resources.\n\n**What NOT to do:**\n- Don't share the code or password\n- Don't call numbers in the message\n\n**If you've already interacted:** Change affected passwords, sign out of all devices, and tell a trusted adult.\n\n_⚠️ Demo preview — real analysis runs when the AI gateway is deployed with GROQ_API_KEY._",
        });
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const ext = file.type.split("/")[1] === "jpeg" ? "jpg" : file.type.split("/")[1];
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("security-screenshots").upload(path, file, { contentType: file.type });
      if (upErr) throw new Error("Upload failed.");

      const { data, error: invErr } = await supabase.functions.invoke("ai-gateway", {
        body: { action: "scan", storage_path: path },
      });
      if (invErr || (data as ScanResult | null)?.error) {
        const code = (data as ScanResult | null)?.error;
        if (code === "AI_GATEWAY_NOT_CONFIGURED") {
          setError("The AI gateway isn't deployed yet. Deploy the edge functions and set GROQ_API_KEY (see the README).");
        } else if (code === "RATE_LIMITED_MINUTE" || code === "RATE_LIMITED_DAY") {
          setError("You've scanned several images in a row. Take a short break and try again.");
        } else {
          setError("Analysis failed. Try a different image.");
        }
        return;
      }
      setResult(data as ScanResult);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
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
            className={`min-h-9 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
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
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
          dragOver ? "border-accent bg-accent-soft" : "border-border-strong bg-surface hover:border-accent"
        }`}
      >
        <span className="text-4xl" aria-hidden="true">📸</span>
        <p className="mt-3 font-semibold text-ink">Drop a screenshot here, click to choose one, or paste an image</p>
        <p className="mt-1 text-sm text-ink-3">PNG, JPEG or WebP · max 8 MB · stored privately</p>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void handleFile(e.target.files?.[0])} />
      </div>

      {busy ? (
        <Card className="flex items-center gap-3 text-ink-2">
          <Spinner /> Analysing your {source.toLowerCase()} screenshot… (files are validated; the AI never repeats personal details)
        </Card>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {result?.reply ? (
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${riskColor(result.risk_level ?? "unknown")}`}>
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
