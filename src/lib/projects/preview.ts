import type { ProjectFile } from "@/lib/projects/paths";

function normaliseRef(ref: string): string {
  return ref.replace(/^\.\//, "").split(/[?#]/)[0];
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

  const byPath = new Map(files.map((file) => [normaliseRef(file.path), file]));
  const base = htmlFile.path.includes("/") ? htmlFile.path.slice(0, htmlFile.path.lastIndexOf("/") + 1) : "";
  const find = (ref: string) => byPath.get(normaliseRef(ref)) ?? byPath.get(normaliseRef(base + ref));

  let html = htmlFile.content;
  html = html.replace(/<link\b([^>]*?)href=["']([^"']+\.css(?:[?#][^"']*)?)["']([^>]*)>/gi, (full, _before: string, href: string) => {
    const css = find(href);
    if (!css || css.encoding === "base64") return full;
    return `<style data-matrix-source="${normaliseRef(href)}">${css.content.replace(/<\/style/gi, "<\\/style")}</style>`;
  });
  html = html.replace(/<script\b([^>]*?)src=["']([^"']+\.(?:js|mjs)(?:[?#][^"']*)?)["']([^>]*)>\s*<\/script>/gi, (full, _before: string, src: string) => {
    const js = find(src);
    if (!js || js.encoding === "base64") return full;
    return `<script data-matrix-source="${normaliseRef(src)}">${js.content.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
  html = html.replace(/(?:src|href)=["']([^"']+\.(?:png|jpe?g|gif|webp|svg|ico)(?:[?#][^"']*)?)["']/gi, (full, ref: string) => {
    const asset = find(ref);
    if (!asset) return full;
    if (asset.encoding === "base64") {
      const ext = ref.split(".").pop()?.split("?")[0] ?? "png";
      const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
      return full.replace(ref, `data:${mime};base64,${asset.content}`);
    }
    if (/\.svg$/i.test(ref)) {
      return full.replace(ref, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asset.content)}`);
    }
    return full;
  });
  if (!/<meta\s+name=["']viewport/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, '<head$1><meta name="viewport" content="width=device-width, initial-scale=1">');
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
