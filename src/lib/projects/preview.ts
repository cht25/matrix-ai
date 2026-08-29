import type { ProjectFile } from "@/lib/projects/paths";

function normaliseRef(ref: string): string {
  return ref.replace(/^\.?\/+/, "").split(/[?#]/)[0];
}

export function buildPreviewHtml(files: ProjectFile[]): { html: string; available: boolean; message: string } {
  const htmlFile =
    files.find((file) => /(^|\/)index\.html?$/i.test(file.path)) ??
    files.find((file) => /\.html?$/i.test(file.path));
  if (!htmlFile || htmlFile.encoding === "base64") {
    return {
      html: "",
      available: false,
      message: files.some((file) => /package\.json$/i.test(file.path))
        ? "This looks like a framework project. Static Live Preview needs an index.html — framework builds are not compiled here."
        : "A browser preview needs an index.html file. Source is still available in Files.",
    };
  }

  const byPath = new Map(files.map((file) => [normaliseRef(file.path).toLowerCase(), file]));
  const base = htmlFile.path.includes("/") ? htmlFile.path.slice(0, htmlFile.path.lastIndexOf("/") + 1) : "";

  const find = (ref: string) => {
    const norm = normaliseRef(ref).toLowerCase();
    const baseNorm = normaliseRef(base + ref).toLowerCase();
    const baseName = norm.split("/").pop() ?? "";
    return (
      byPath.get(norm) ??
      byPath.get(baseNorm) ??
      files.find((f) => normaliseRef(f.path).toLowerCase().split("/").pop() === baseName) ??
      (baseName.endsWith(".css") ? files.find((f) => f.path.toLowerCase().endsWith(".css")) : undefined) ??
      (baseName.endsWith(".js") ? files.find((f) => f.path.toLowerCase().endsWith(".js")) : undefined)
    );
  };

  let html = htmlFile.content;

  // Replace stylesheet <link> tags with inlined <style>
  html = html.replace(/<link\b([^>]*?)href=["']([^"']+\.css(?:[?#][^"']*)?)["']([^>]*)\/?>/gi, (full, _before: string, href: string) => {
    if (/^https?:\/\//i.test(href) || href.startsWith("//")) return full;
    const css = find(href);
    if (!css || css.encoding === "base64") return full;
    return `<style data-matrix-source="${normaliseRef(href)}">\n${css.content.replace(/<\/style/gi, "<\\/style")}\n</style>`;
  });

  // Replace script tags with inlined <script>
  html = html.replace(/<script\b([^>]*?)src=["']([^"']+\.(?:js|mjs|cjs|ts)(?:[?#][^"']*)?)["']([^>]*)>\s*<\/script>/gi, (full, before: string, src: string, after: string) => {
    if (/^https?:\/\//i.test(src) || src.startsWith("//")) return full;
    const js = find(src);
    if (!js || js.encoding === "base64") return full;
    const isModule = /type=["']module["']/i.test(before) || /type=["']module["']/i.test(after);
    const typeAttr = isModule ? ' type="module"' : "";
    return `<script${typeAttr} data-matrix-source="${normaliseRef(src)}">\n${js.content.replace(/<\/script/gi, "<\\/script")}\n</script>`;
  });

  // Replace image/asset references with base64/data URIs
  html = html.replace(/(?:src|href)=["']([^"']+\.(?:png|jpe?g|gif|webp|svg|ico|avif)(?:[?#][^"']*)?)["']/gi, (full, ref: string) => {
    if (/^https?:\/\//i.test(ref) || ref.startsWith("//") || ref.startsWith("data:")) return full;
    const asset = find(ref);
    if (!asset) return full;
    if (asset.encoding === "base64") {
      const ext = ref.split(".").pop()?.split("?")[0]?.toLowerCase() ?? "png";
      const mime = ext === "svg" ? "image/svg+xml" : ext === "ico" ? "image/x-icon" : `image/${ext === "jpg" ? "jpeg" : ext}`;
      return full.replace(ref, `data:${mime};base64,${asset.content}`);
    }
    if (/\.svg$/i.test(ref)) {
      return full.replace(ref, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asset.content)}`);
    }
    return full;
  });

  if (!/<meta\s+name=["']viewport/i.test(html)) {
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/(<head\b[^>]*>)/i, '$1\n<meta name="viewport" content="width=device-width, initial-scale=1">');
    }
  }

  return { html, available: true, message: "Static HTML/CSS/JavaScript preview" };
}

export function detectEditorIssues(path: string, content: string): string[] {
  const issues: string[] = [];
  if (/\.html?$/i.test(path)) {
    const open = (content.match(/</g) ?? []).length;
    const close = (content.match(/>/g) ?? []).length;
    if (open !== close) issues.push("HTML tags look unbalanced (count of < and > differs).");
    if (/<html[\s>]/i.test(content) && !/<\/html>/i.test(content)) issues.push("Missing </html>.");
    if (/<script[\s>]/i.test(content) && !/<\/script>/i.test(content)) issues.push("A <script> tag may be unclosed.");
  }
  if (/\.(?:js|mjs|cjs)$/i.test(path)) {
    const pairs: [string, string, string][] = [
      ["{", "}", "curly braces"],
      ["(", ")", "parentheses"],
      ["[", "]", "square brackets"],
    ];
    for (const [a, b, label] of pairs) {
      const left = (content.match(new RegExp(`\\${a}`, "g")) ?? []).length;
      const right = (content.match(new RegExp(`\\${b}`, "g")) ?? []).length;
      if (left !== right) issues.push(`JavaScript ${label} look unbalanced.`);
    }
  }
  return issues.slice(0, 4);
}
