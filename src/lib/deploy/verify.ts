import type { ProjectFile } from "@/lib/projects/paths";

export type PublishedVerification = { ok: boolean; checked: string[]; error: string | null };

function localAssetPaths(html: string): string[] {
  const out = new Set<string>();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.size < 12) {
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
      const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
      const marker = normalize(entry.content).slice(0, 100);
      if (marker && !normalize(served).includes(marker)) {
        return { ok: false, checked, error: "Public URL served different content than the staged entry document (possibly cached old release)." };
      }
    }
    if (entry && entry.encoding !== "base64") {
      for (const asset of localAssetPaths(entry.content)) {
        const url = new URL(asset, base).toString();
        if (new URL(url).origin !== new URL(input.origin).origin) continue;
        const assetRes = await get(url);
        if (!assetRes.ok) return { ok: false, checked, error: await httpError(`Asset ${asset}`, assetRes) };
      }
    }
    return { ok: true, checked, error: null };
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
