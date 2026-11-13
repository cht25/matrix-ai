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
}): Promise<PublishedVerification> {
  const doFetch = input.fetchImpl ?? fetch;
  const root = `${input.origin.replace(/\/+$/, "")}/s/${input.slug}`;
  const base = `${root}/`;
  const entry = input.files.find((file) => /(^|\/)index\.html?$/i.test(file.path)) ?? input.files.find((file) => /\.html?$/i.test(file.path));
  const checked: string[] = [];
  const get = async (url: string): Promise<Response> => {
    checked.push(url);
    // A redirect could silently verify a localhost/private upstream (or login
    // page) instead of the published site. Every local path must serve 200.
    return doFetch(url, { redirect: "manual", signal: AbortSignal.timeout(input.timeoutMs ?? 10_000), headers: { "Cache-Control": "no-cache" } });
  };
  try {
    // Admin links and persisted public URLs use the no-slash address. Test
    // that exact entry point too: a proxy/framework-generated absolute 308
    // could otherwise be missed by verification of only the slash URL.
    const entryResponse = await get(root);
    if (entryResponse.status === 308) {
      const location = entryResponse.headers.get("location");
      if (location !== `/s/${input.slug}/`) {
        return { ok: false, checked, error: "Public URL redirected outside the site path." };
      }
    } else if (!entryResponse.ok) {
      return { ok: false, checked, error: `Public URL returned HTTP ${entryResponse.status}.` };
    }
    const res = entryResponse.ok ? entryResponse : await get(base);
    if (!res.ok) return { ok: false, checked, error: `Public URL returned HTTP ${res.status}${res.headers.get("location") ? " (redirected)" : ""}.` };
    const body = await res.text();
    if (!body.trim()) return { ok: false, checked, error: "Public URL returned an empty document." };
    if (entry && entry.encoding !== "base64") {
      const marker = entry.content.replace(/\s+/g, " ").slice(0, 80).trim();
      if (marker && !body.replace(/\s+/g, " ").includes(marker) && !/<base\b/i.test(body)) {
        return { ok: false, checked, error: "Public URL did not serve the uploaded entry document." };
      }
    }
    if (entry && entry.encoding !== "base64") {
      for (const asset of localAssetPaths(entry.content)) {
        const url = new URL(asset, base).toString();
        if (!url.startsWith(input.origin)) continue;
        const assetRes = await get(url);
        if (!assetRes.ok) return { ok: false, checked, error: `Asset ${asset} returned HTTP ${assetRes.status}.` };
      }
    }
    return { ok: true, checked, error: null };
  } catch (error) {
    return { ok: false, checked, error: error instanceof Error ? error.message.slice(0, 160) : "Public verification request failed." };
  }
}
