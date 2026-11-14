import type { ProjectFile } from "@/lib/projects/paths";

export type PublishedVerification = { ok: boolean; checked: string[]; error: string | null; pages?: number; assets?: number };

/** Upper bounds so a very large site cannot stall a publish. Everything beyond is reported as not checked. */
export const VERIFY_LIMITS = { pages: 30, assets: 60, concurrency: 6 } as const;

function localAssetPaths(html: string): string[] {
  const out = new Set<string>();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.size < 40) {
    const value = match[1].trim();
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value)) continue;
    out.add(value.replace(/^\.\//, "").split(/[?#]/)[0]);
  }
  return [...out].filter(Boolean);
}

/** HTTP-verifies the canonical public URL and a bounded set of local assets.
 * A database write alone is never treated as proof that hosting works. */
export async function verifyPublishedDeployment(input: {
  origin: string;
  slug: string;
  files: ProjectFile[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  staging?: { releaseId: string; token: string };
}): Promise<PublishedVerification> {
  const doFetch = input.fetchImpl ?? fetch;
  const root = `${input.origin.replace(/\/+$/, "")}/s/${input.slug}`;
  const base = `${root}/`;
  const entry = input.files.find((file) => /(^|\/)index\.html?$/i.test(file.path)) ?? input.files.find((file) => /\.html?$/i.test(file.path));
  const checked: string[] = [];
  const verificationQuery = input.staging ? `__matrix_verify=${encodeURIComponent(input.staging.releaseId)}` : "";
  const verifyUrl = (url: string) => verificationQuery ? `${url}${url.includes("?") ? "&" : "?"}${verificationQuery}` : url;
  const get = async (url: string): Promise<Response> => {
    url = verifyUrl(url);
    checked.push(url);
    // A redirect could silently verify a localhost/private upstream (or login
    // page) instead of the published site. Every local path must serve 200.
    return doFetch(url, { redirect: "manual", signal: AbortSignal.timeout(input.timeoutMs ?? 10_000), headers: { "Cache-Control": "no-cache", ...(input.staging ? { "x-matrix-verification-token": input.staging.token } : {}) } });
  };
  try {
    // Admin links and persisted public URLs use the no-slash address. Test
    // that exact entry point too: a proxy/framework-generated absolute 308
    // could otherwise be missed by verification of only the slash URL.
    const entryResponse = await get(root);
    if (entryResponse.status === 308) {
      const location = entryResponse.headers.get("location");
      if (location !== `/s/${input.slug}/${verificationQuery ? `?${verificationQuery}` : ""}`) {
        return { ok: false, checked, error: `Public URL redirected outside the site path (${String(location).slice(0, 120)}).` };
      }
    } else if (!entryResponse.ok) {
      return { ok: false, checked, error: await httpError("Public URL", entryResponse) };
    }
    const res = entryResponse.ok ? entryResponse : await get(base);
    if (!res.ok) return { ok: false, checked, error: await httpError("Public URL", res) };
    const body = await res.text();
    if (!body.trim()) return { ok: false, checked, error: "Public URL returned an empty document." };
    if (entry && entry.encoding !== "base64") {
      // The host injects one site-scoped <base>. Remove only that known tag
      // before comparing an unchanged source fragment. Never accept an old
      // document just because it also has a <base> element.
      const served = /<base\b/i.test(entry.content) ? body : body.replace(new RegExp(`<base\\s+href=["\']\/s\/${input.slug}\/["\']\\s*/?\\s*>`, "i"), "");
      // Compare with all whitespace removed: the host adds its <base> on a new
      // line, which changed the spacing of a compact "<head><meta…" document and
      // made a correct release look like different content.
      const normalize = (text: string) => text.replace(/\s+/g, "");
      const marker = normalize(entry.content).slice(0, 100);
      if (marker && !normalize(served).includes(marker)) {
        return { ok: false, checked, error: "Public URL served different content than the staged entry document (possibly cached old release)." };
      }
    }
    // Every page of the site — nested routes included — must answer 200 with
    // a document, exactly as a visitor opening or refreshing that URL gets it.
    const pages = input.files.filter((file) => /\.html?$/i.test(file.path) && file.encoding !== "base64" && file !== entry).slice(0, VERIFY_LIMITS.pages);
    const published = new Set(input.files.map((file) => file.path));
    // Assets every page loads: stylesheets, scripts, images that are part of
    // this release. (A reference to a file that was never in the release is a
    // validation finding, reported there — not a hosting failure.)
    const assets = new Set<string>();
    for (const page of entry && entry.encoding !== "base64" ? [entry, ...pages] : pages) {
      const dir = page.path.includes("/") ? page.path.slice(0, page.path.lastIndexOf("/") + 1) : "";
      for (const ref of localAssetPaths(page.content)) {
        let resolved: string;
        try { resolved = decodeURIComponent(new URL(ref, `https://site.invalid/${dir}`).pathname.slice(1)); } catch { continue; }
        if (/\.html?$/i.test(resolved) || !resolved || resolved.endsWith("/")) continue;
        if (page === entry || published.has(resolved)) assets.add(resolved);
        if (assets.size >= VERIFY_LIMITS.assets) break;
      }
    }
    const jobs: Array<{ label: string; url: string; page: boolean }> = [
      ...pages.map((page) => ({ label: `Page ${page.path}`, url: new URL(page.path.split("/").map(encodeURIComponent).join("/"), base).toString(), page: true })),
      ...[...assets].map((asset) => ({ label: `Asset ${asset}`, url: new URL(asset.split("/").map(encodeURIComponent).join("/"), base).toString(), page: false })),
    ];
    let failure: string | null = null;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length && !failure) {
        const job = jobs[cursor++];
        const response = await get(job.url);
        if (!response.ok) { failure = failure ?? await httpError(job.label, response); return; }
        if (job.page && !(await response.text()).trim()) { failure = failure ?? `${job.label} returned an empty document.`; return; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(VERIFY_LIMITS.concurrency, jobs.length) }, worker));
    if (failure) return { ok: false, checked, error: failure, pages: pages.length + 1, assets: assets.size };
    return { ok: true, checked, error: null, pages: pages.length + 1, assets: assets.size };
  } catch (error) {
    return { ok: false, checked, error: error instanceof Error ? error.message.slice(0, 160) : "Public verification request failed." };
  }
}

async function httpError(label: string, response: Response): Promise<string> {
  const location = response.headers.get("location");
  // Public HTML can contain user data: log only a short, sanitized excerpt.
  const body = location ? "" : (await response.text().catch(() => "")).replace(/[\r\n\t]+/g, " ").slice(0, 120);
  return `${label} returned HTTP ${response.status}${location ? `; Location: ${location.slice(0, 120)}` : body ? `; body: ${body}` : ""}.`;
}
