"use client";

// Dynamic Design Studio — describe a design in natural language, preview the
// validated token result, then approve to persist it. The server validates
// every token (allowlists + WCAG contrast) and keeps version history; user
// CSS/JS can never reach the app.

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Field, Textarea } from "@/components/ui";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import { Palette } from "lucide-react";

type Tokens = {
  mode: "dark" | "light";
  colors: { bg: string; surface: string; ink: string; accent: string };
  density: string;
  sidebar: string;
  fontFamily: string;
  radius: string;
};

type Preview = {
  ok: boolean;
  tokens?: Tokens;
  summary: string;
  contrastIssues?: { pair: string; ratio: number; required: number }[];
};

type Version = { version: number; tokens: Tokens; source: string; summary: string; created_at: string };

function errMsg(err: unknown, fallback: string): string {
  if (err instanceof RpcCallError) return err.code.replace(/_/g, " ").toLowerCase();
  return fallback;
}

function Swatch({ label, color }: { label: string; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-7 w-7 rounded-[8px] border border-border" style={{ backgroundColor: color }} />
      <span className="text-xs text-ink-3">
        {label} <code className="font-mono">{color}</code>
      </span>
    </div>
  );
}

export function DesignStudioClient() {
  const toast = useToast();
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [current, setCurrent] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [v, c] = await Promise.all([
        rpc<Version[]>("design_versions"),
        rpc<Version | null>("design_current"),
      ]);
      setVersions(v);
      setCurrent(c);
    } catch {
      // Honest: leave lists empty, the page still works for preview/save.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runPreview() {
    setBusy(true);
    try {
      setPreview(await rpc<Preview>("design_preview", { instruction }));
    } catch (err) {
      toast(errMsg(err, "Preview failed."));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview?.ok || !preview.tokens) return;
    setBusy(true);
    try {
      await rpc("design_save", { tokens: preview.tokens, source: "instruction", summary: preview.summary });
      toast("Design saved and applied to your account.");
      setPreview(null);
      await load();
    } catch (err) {
      toast(errMsg(err, "Could not save the design."));
    } finally {
      setBusy(false);
    }
  }

  async function applyVersion(version: number) {
    setBusy(true);
    try {
      await rpc("design_apply_version", { version });
      toast(`Version ${version} applied.`);
      await load();
    } catch (err) {
      toast(errMsg(err, "Could not apply that version."));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await rpc("design_reset");
      toast("Reset to the MATRIX default design.");
      await load();
    } catch (err) {
      toast(errMsg(err, "Could not reset."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Design Studio</h1>
        <p className="mt-1 text-ink-2">
          Describe the interface you want — for example “a warm white interface with a compact sidebar, elegant typography and
          soft borders”. MATRIX converts it to validated, accessible design tokens, shows a preview, and only applies it after
          you approve.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold text-ink">Describe your design</h2>
          <Field label="Design instruction" htmlFor="design-instruction">
            <Textarea
              id="design-instruction"
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="warm white interface with a compact sidebar, elegant typography, soft borders…"
            />
          </Field>
          <div className="flex gap-2">
            <Button onClick={runPreview} disabled={busy || !instruction.trim()}>Preview</Button>
            <Button variant="secondary" onClick={apply} disabled={busy || !preview?.ok}>
              Approve &amp; apply
            </Button>
          </div>

          {preview ? (
            <div className="space-y-3 border-t border-border pt-3">
              {preview.ok && preview.tokens ? (
                <>
                  <Alert tone="success">{preview.summary}</Alert>
                  <div
                    className="rounded-[12px] border border-border p-3"
                    style={{ backgroundColor: preview.tokens.colors.bg, color: preview.tokens.colors.ink }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold" style={{ color: preview.tokens.colors.accent }}>
                        MATRIX preview
                      </span>
                      <Badge>{preview.tokens.mode}</Badge>
                    </div>
                    <div
                      className="mt-2 rounded-[8px] p-2 text-xs"
                      style={{ backgroundColor: preview.tokens.colors.surface }}
                    >
                      A live sample surface — text contrast is enforced before this can be saved.
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Swatch label="Background" color={preview.tokens.colors.bg} />
                    <Swatch label="Surface" color={preview.tokens.colors.surface} />
                    <Swatch label="Text" color={preview.tokens.colors.ink} />
                    <Swatch label="Accent" color={preview.tokens.colors.accent} />
                  </div>
                  <p className="text-xs text-ink-3">
                    {preview.tokens.density} density · {preview.tokens.sidebar} sidebar · {preview.tokens.fontFamily} type ·{" "}
                    {preview.tokens.radius} corners
                  </p>
                </>
              ) : (
                <Alert tone="danger">
                  {preview.summary}
                  {preview.contrastIssues?.map((i) => (
                    <span key={i.pair} className="block text-xs">
                      {i.pair}: {i.ratio}:1 (needs {i.required}:1)
                    </span>
                  ))}
                </Alert>
              )}
            </div>
          ) : null}
        </Card>

        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-ink">Saved versions</h2>
            <Button variant="ghost" onClick={reset} disabled={busy}>Reset to default</Button>
          </div>
          {current ? (
            <Alert tone="info">
              Current: version {current.version} ({current.source}) — {current.summary}
            </Alert>
          ) : null}
          {versions.length === 0 ? (
            <p className="text-sm text-ink-3">No custom designs saved yet. The MATRIX default is active.</p>
          ) : (
            <ul className="space-y-2">
              {versions.map((v) => (
                <li key={v.version} className="flex items-center justify-between gap-2 rounded-[10px] bg-surface-2 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="h-5 w-5 rounded-[6px] border border-border" style={{ backgroundColor: v.tokens.colors.bg }} />
                    <div>
                      <p className="text-sm font-medium text-ink">
                        v{v.version} <Badge>{v.source}</Badge>
                      </p>
                      <p className="text-xs text-ink-3">{v.summary || new Date(v.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                  <Button variant="secondary" onClick={() => void applyVersion(v.version)} disabled={busy}>
                    Apply
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="flex items-center gap-2 text-xs text-ink-3">
        <Palette size={14} /> Designs are validated token sets — custom colors, density, sidebar, typography and corners only.
        Accessibility (WCAG contrast) is enforced server-side before anything is saved.
      </p>
    </div>
  );
}
