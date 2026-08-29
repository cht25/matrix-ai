// Standalone-site bundler.
//
// Turns a MATRIX Agent project (a tree of HTML / CSS / JS / asset files) into
// a single self-contained HTML document: every local stylesheet is inlined
// into a <style> tag, every local script into a <script> tag, local images,
// favicons and CSS url(...) resources become data: URIs, and window.MATRIX_ENV
// is injected. The published root page therefore renders perfectly at
// /s/<slug>/ with no dependency on sibling files — "completely ready" the
// moment it goes public.

import type { ProjectFile } from "@/lib/projects/paths";
import { contentTypeForPath, fileExtension } from "@/lib/projects/paths";

export function normalizeRef(ref: string): string {
  return ref.replace(/^[./]+/, "").split(/[?#]/)[0].replace(/^\.?\//, "");
}

function isRemoteRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref) || ref.startsWith("//") || ref.startsWith("data:") || ref.startsWith("blob:") || ref.startsWith("mailto:") || ref.startsWith("tel:") || ref.startsWith("#");
}

/** Find a file referenced by `ref`, tolerating `./`, base-relative and basename matches. */
export function resolveFile(files: ProjectFile[], ref: string, fromPath?: string): ProjectFile | undefined {
  if (isRemoteRef(ref)) return undefined;
  const norm = normalizeRef(ref).toLowerCase();
  if (!norm) return undefined;
  const byPath = new Map(files.map((file) => [file.path.replace(/^[/.]+/, "").toLowerCase(), file]));

  const direct = byPath.get(norm);
  if (direct) return direct;

  // Base-relative: the page lives in `dir`, try `dir/ref`.
  if (fromPath && fromPath.includes("/")) {
    const dir = fromPath.slice(0, fromPath.lastIndexOf("/") + 1);
    const candidate = (dir + norm).replace(/^\.?\//, "").toLowerCase();
    const baseMatch = byPath.get(candidate);
    if (baseMatch) return baseMatch;
  }

  const baseName = norm.split("/").pop() ?? "";
  return (
    files.find((file) => file.path.replace(/^[/.]+/, "").toLowerCase().split("/").pop() === baseName) ??
    (baseName.endsWith(".css") ? files.find((file) => /\.css$/i.test(file.path)) : undefined) ??
    (baseName.endsWith(".js") || baseName.endsWith(".mjs") ? files.find((file) => /\.(?:js|mjs|cjs)$/i.test(file.path)) : undefined)
  );
}

/** Inline all CSS url(...) references and @import url(...) to data URIs. */
function inlineCssResources(css: string, files: ProjectFile[], fromPath?: string, seen = new Set<string>()): string {
  const replaceUrl = (raw: string) => {
    const ref = raw.trim().replace(/^['"]|['"]$/g, "").trim();
    if (!ref || isRemoteRef(ref)) return raw;
    const asset = resolveFile(files, ref, fromPath);
    if (!asset) return raw;
    // Raster/binary assets inside CSS stay as relative references — the
    // published root page carries a <base> tag so they load from the site's
    // file collection. SVG (small text) is inlined so the page keeps working
    // even when opened straight from the inlined document.
    if (asset.encoding === "base64" && !/\.svg$/i.test(asset.path)) return raw;
    return `"${toDataUri(asset)}"`;
  };
  return css
    .replace(/url\(\s*(['"]?[^)'"]+['"]?)\s*\)/gi, (whole, inner: string) => {
      try {
        return `url(${replaceUrl(inner)})`;
      } catch {
        return whole;
      }
    })
    // Resolve @import "file.css" / @import url("file.css") recursively.
    .replace(/@import\s+(?:url\(\s*)?['"]([^'"]+\.css)['"]\s*(?:\))?\s*;?/gi, (whole, href: string) => {
      if (isRemoteRef(href)) return whole;
      const cssFile = resolveFile(files, href, fromPath);
      if (!cssFile || cssFile.encoding === "base64" || seen.has(cssFile.path)) return "";
      seen.add(cssFile.path);
      return `/* @import ${cssFile.path} */\n${inlineCssResources(cssFile.content, files, cssFile.path, seen)}\n`;
    });
}

export function toDataUri(file: ProjectFile): string {
  const ext = fileExtension(file.path);
  if (file.encoding === "base64") {
    return `data:${contentTypeForPath(file.path).split(";")[0]};base64,${file.content}`;
  }
  if (/\.svg$/i.test(file.path)) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`;
  }
  return `data:${contentTypeForPath(file.path).split(";")[0]};base64,${Buffer.from(file.content, "utf8").toString("base64")}`;
}

const ASSET_REF_ATTRS = /(?:src|href|poster|data-src|xlink:href)\s*=\s*["']([^"']+)["']/gi;
const ASSET_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|avif|bmp|woff2?|ttf|otf|eot|mp3|mp4|wav|webm|json|webmanifest)(?:[?#][^"']*)?$/i;

/**
 * Produce a fully self-contained version of one HTML file: local CSS is
 * inlined as <style> (with its url() resources inlined), local JS as inline
 * <script>, and local asset references become data: URIs. Returns the
 * rewritten HTML, plus the number of inlined resources (for publish logs).
 */
/** Keep the resulting document under Firestore's ~1 MiB document limit. */
const MAX_INLINED_BYTES = 900_000;

export function inlineHtmlDocument(
  html: string,
  files: ProjectFile[],
  htmlPath: string,
  opts: { envPublic?: Record<string, string> } = {},
): { html: string; inlined: number } {
  let inlined = 0;
  let inlinedBytes = 0;
  const cssCache = new Map<string, string>();

  // Text resources (CSS/JS) are always inlined — they are the whole point of
  // a self-contained page. Binary data: URIs count against a budget; once it
  // is spent the asset is left as a normal relative reference (the published
  // route injects a <base> tag so it still loads as a sibling file).
  const roomFor = (estimated: number) => inlinedBytes + estimated < MAX_INLINED_BYTES;
  const addText = (chars: number) => {
    inlined += 1;
    inlinedBytes += chars;
  };
  const addAsset = (asset: ProjectFile): string | null => {
    const dataUri = toDataUri(asset);
    // data: URIs inflate ~33% for base64; budget against the encoded length.
    if (!roomFor(Math.ceil(dataUri.length * 1.05))) return null;
    inlined += 1;
    inlinedBytes += Math.ceil(dataUri.length * 1.05);
    return dataUri;
  };

  const cssFor = (file: ProjectFile): string => {
    const cached = cssCache.get(file.path);
    if (cached !== undefined) return cached;
    const inlinedCss = inlineCssResources(file.content, files, file.path);
    cssCache.set(file.path, inlinedCss);
    return inlinedCss;
  };

  // 1. <link rel="stylesheet" href="...local.css"> -> <style>…</style>
  let out = html.replace(
    /<link\b([^>]*?)href=["']([^"']+)["']([^>]*)>/gi,
    (full: string, before: string, href: string) => {
      const attrs = `${before} `;
      const isStylesheet = /rel\s*=\s*["'][^"']*stylesheet/i.test(attrs) || /\.css(?:[?#]|$)/i.test(href);
      if (!isStylesheet || isRemoteRef(href)) {
        // Favicon / manifest / icon links pointing at a local asset: inline them.
        if (!isRemoteRef(href) && ASSET_EXT.test(href.split("?")[0] ?? href)) {
          const asset = resolveFile(files, href, htmlPath);
          if (asset) {
            const uri = addAsset(asset);
            if (uri) return full.replace(href, uri);
          }
        }
        return full;
      }
      const cssFile = resolveFile(files, href, htmlPath);
      if (!cssFile || cssFile.encoding === "base64") return full;
      const content = cssFor(cssFile).replace(/<\/style/gi, "<\\/style");
      addText(content.length);
      return `<style data-matrix-source="${cssFile.path}">\n${content}\n</style>`;
    },
  );

  // 2. <script src="...local.js"></script> -> inline <script>
  out = out.replace(
    /<script\b([^>]*?)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    (full: string, before: string, src: string, after: string) => {
      if (isRemoteRef(src)) return full;
      const jsFile = resolveFile(files, src, htmlPath);
      if (!jsFile || jsFile.encoding === "base64") return full;
      const isModule = /type=["']module["']/i.test(`${before} ${after}`);
      const typeAttr = isModule ? ' type="module"' : "";
      const content = jsFile.content.replace(/<\/script/gi, "<\\/script");
      addText(content.length);
      return `<script${typeAttr} data-matrix-source="${jsFile.path}">\n${content}\n</script>`;
    },
  );

  // 3. Local image/asset references in src/href/poster/data-src attributes.
  out = out.replace(ASSET_REF_ATTRS, (full, ref: string) => {
    if (isRemoteRef(ref) || /\.html?(?:[?#]|$)/i.test(ref)) return full;
    if (!ASSET_EXT.test(ref.split("?")[0] ?? ref)) return full;
    const asset = resolveFile(files, ref, htmlPath);
    if (!asset) return full;
    const uri = addAsset(asset);
    return uri ? full.replace(ref, uri) : full;
  });

  // 4. CSS-in-HTML <style> blocks: inline their url() resources too.
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (full, block: string) => {
    const rewritten = inlineCssResources(block, files, htmlPath);
    if (rewritten === block) return full;
    return full.replace(block, rewritten);
  });

  // 5. Inline <img srcset="..."> resource sets.
  out = out.replace(/srcset\s*=\s*["']([^"']+)["']/gi, (full, value: string) => {
    const rewritten = value
      .split(",")
      .map((candidate) => {
        const [url, descriptor] = candidate.trim().split(/\s+/);
        if (!url || isRemoteRef(url)) return candidate.trim();
        const asset = resolveFile(files, url, htmlPath);
        if (!asset) return candidate.trim();
        const uri = addAsset(asset);
        return uri ? [uri, descriptor].filter(Boolean).join(" ") : candidate.trim();
      })
      .join(", ");
    return full.replace(value, rewritten);
  });

  // 6. Inject public env vars for the site's JS.
  if (opts.envPublic && Object.keys(opts.envPublic).length) {
    const envScript = `<script data-matrix-env>window.MATRIX_ENV=${JSON.stringify(opts.envPublic)};</script>`;
    if (/<head\b[^>]*>/i.test(out)) {
      out = out.replace(/(<head\b[^>]*>)/i, `$1\n${envScript}`);
    } else {
      out = `${envScript}\n${out}`;
    }
  }

  // 7. Ensure a viewport meta tag so published mobile pages render correctly.
  if (!/<meta\s+name=["']viewport/i.test(out) && /<head\b[^>]*>/i.test(out)) {
    out = out.replace(/(<head\b[^>]*>)/i, '$1\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  }

  return { html: out, inlined };
}

/**
 * Build the set of files to write to a published site. The root document
 * (`index.html` at the top level, or the only HTML file when there is no
 * index) is published as a single self-contained page so `/s/<slug>/` works
 * with no extra requests; every other project file is published unchanged so
 * deeper pages, downloads and assets keep working.
 */
export function buildPublishedFiles(files: ProjectFile[], envPublic?: Record<string, string>): {
  outFiles: { path: string; content: string; language: string; encoding: "utf8" | "base64" }[];
  standalone: { path: string; inlined: number } | null;
} {
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path) && f.encoding !== "base64");
  const rootHtml =
    htmlFiles.find((f) => /(^|\/)index\.html?$/i.test(f.path)) ??
    (htmlFiles.length === 1 ? htmlFiles[0] : null);

  const outFiles = files.map((f) => ({
    path: f.path,
    content: f.content,
    language: f.language,
    encoding: f.encoding ?? ("utf8" as const),
  }));

  if (!rootHtml) return { outFiles, standalone: null };

  const { html, inlined } = inlineHtmlDocument(rootHtml.content, files, rootHtml.path, { envPublic });
  const rootTarget = /(^|\/)index\.html?$/i.test(rootHtml.path) ? rootHtml.path : "index.html";
  const existing = outFiles.find((f) => f.path === rootTarget);
  if (existing) {
    existing.content = html;
  } else {
    outFiles.push({ path: "index.html", content: html, language: "html", encoding: "utf8" });
  }

  return { outFiles, standalone: { path: rootTarget, inlined } };
}
