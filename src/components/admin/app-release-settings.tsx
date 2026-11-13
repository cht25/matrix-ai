"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { errorCodeOf } from "@/lib/admin-errors";
import { Alert, Badge, Button, Card, Field, Input, Spinner, Textarea } from "@/components/ui";

type ReleaseRecord = {
  version: string;
  build_number: number;
  min_supported_version: string;
  force_update: boolean;
  apk_url: string;
  sha256: string;
  release_notes: string;
  published_at: string;
};

const ERRORS: Record<string, string> = {
  PERMISSION_DENIED: "Your role needs system.settings permission to publish phone app updates.",
  APP_VERSION_INVALID: "Enter a valid semantic version such as 1.1.0.",
  APP_MIN_VERSION_INVALID: "Enter a valid minimum semantic version such as 1.0.0.",
  APP_MIN_VERSION_EXCEEDS_LATEST: "Minimum supported version cannot be higher than the latest version.",
  APP_BUILD_NUMBER_INVALID: "Enter a positive integer Android versionCode / build number.",
  APP_APK_URL_INVALID: "APK download URL must be a valid HTTPS link.",
  APP_SHA256_INVALID: "SHA-256 checksum must be a 64-character hex string (or blank).",
};

export function AppReleaseSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState("1.1.0");
  const [buildNumber, setBuildNumber] = useState("2");
  const [minVersion, setMinVersion] = useState("1.0.0");
  const [forceUpdate, setForceUpdate] = useState(false);
  const [apkUrl, setApkUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const data = await rpc<ReleaseRecord>("admin_app_release_get");
      setVersion(data.version);
      setBuildNumber(String(data.build_number));
      setMinVersion(data.min_supported_version);
      setForceUpdate(data.force_update);
      setApkUrl(data.apk_url);
      setSha256(data.sha256 ?? "");
      setReleaseNotes(data.release_notes ?? "");
      setPublishedAt(data.published_at ?? "");
    } catch (err) {
      const code = errorCodeOf(err, "LOAD_FAILED");
      setNotice({ tone: "danger", text: ERRORS[code] ?? "Could not load phone release settings." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const saved = await rpc<ReleaseRecord>("admin_app_release_save", {
        version: version.trim(),
        build_number: Number.parseInt(buildNumber, 10) || 1,
        min_supported_version: minVersion.trim(),
        force_update: forceUpdate,
        apk_url: apkUrl.trim(),
        sha256: sha256.trim(),
        release_notes: releaseNotes.trim(),
      });
      setPublishedAt(saved.published_at);
      setNotice({
        tone: "success",
        text: `Published Android & mobile PWA release v${saved.version} (build ${saved.build_number}). Connected phones receive this update immediately.`,
      });
    } catch (err) {
      const code = errorCodeOf(err, "SAVE_FAILED");
      setNotice({ tone: "danger", text: ERRORS[code] ?? "Could not publish app release." });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <span className="inline-status"><Spinner /> Loading phone update release…</span>
      </Card>
    );
  }

  return (
    <Card className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Phone OTA · Mobile releases</p>
          <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold text-ink">
            <Smartphone size={18} className="text-accent" /> Phone App Update System
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            Controls over-the-air update prompts on the MATRIX Android phone app and mobile PWA at{" "}
            <span className="mono text-xs text-ink">https://matrix.thamjj13.top/chat</span>. Phones poll{" "}
            <span className="mono text-xs text-ink">/api/app/version</span> on launch and resume.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="!border-success/40 !text-success">v{version} · build {buildNumber}</Badge>
          {publishedAt ? <Badge>{new Date(publishedAt).toLocaleDateString()}</Badge> : null}
        </div>
      </header>

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Latest version (semver)" htmlFor="app-rel-version" hint="Example: 1.1.0">
          <Input id="app-rel-version" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.1.0" />
        </Field>
        <Field label="Android build / versionCode" htmlFor="app-rel-build" hint="Must increment on each APK build">
          <Input id="app-rel-build" type="number" min={1} value={buildNumber} onChange={(e) => setBuildNumber(e.target.value)} placeholder="2" />
        </Field>
        <Field label="Minimum supported version" htmlFor="app-rel-min" hint="Older phones are forced to update">
          <Input id="app-rel-min" value={minVersion} onChange={(e) => setMinVersion(e.target.value)} placeholder="1.0.0" />
        </Field>
      </div>

      <Field label="Direct Android APK download URL (HTTPS)" htmlFor="app-rel-apk" hint="GitHub Release asset or CDN link opened when phone users tap Update.">
        <Input id="app-rel-apk" type="url" value={apkUrl} onChange={(e) => setApkUrl(e.target.value)} placeholder="https://github.com/cht25/matrix-ai/releases/latest/download/matrix-android.apk" />
      </Field>

      <Field label="APK SHA-256 checksum (optional)" htmlFor="app-rel-sha" hint="64-character hex digest for package verification.">
        <Input id="app-rel-sha" value={sha256} onChange={(e) => setSha256(e.target.value)} placeholder="Optional 64-char SHA-256" spellCheck={false} />
      </Field>

      <Field label="What's new / Release notes" htmlFor="app-rel-notes">
        <Textarea id="app-rel-notes" rows={4} value={releaseNotes} onChange={(e) => setReleaseNotes(e.target.value)} placeholder="Describe improvements and fixes in this phone release…" />
      </Field>

      <label className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-3 py-2.5 text-sm text-ink-2">
        <input type="checkbox" checked={forceUpdate} onChange={(e) => setForceUpdate(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
        Require immediate mandatory update for all older phone app builds
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? <Spinner /> : <ShieldCheck size={15} />} Publish phone release
        </Button>
        <Button type="button" variant="outline" onClick={() => void load()} disabled={saving}>
          <RefreshCw size={14} /> Reload
        </Button>
        {apkUrl ? (
          <a
            href={apkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-ink-2 hover:text-ink"
          >
            <Download size={13} /> Test APK link
          </a>
        ) : null}
      </div>
    </Card>
  );
}
