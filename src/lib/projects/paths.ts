import { languageForPath, safeAgentPath } from "@/lib/ai/agent";

export const PROJECT_LIMITS = {
  maxProjectsPerUser: 20,
  maxFilesPerProject: 80,
  maxTextBytes: 200 * 1024,
  maxImageBytes: 1.5 * 1024 * 1024,
  maxImageBytesPerProject: 5 * 1024 * 1024,
  maxVersions: 25,
};

export const TEXT_EXTENSIONS = new Set([
  "html", "htm", "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx",
  "json", "jsonc", "svg", "txt", "md", "mdx", "xml", "csv", "yml", "yaml", "toml",
  "env", "map", "webmanifest", "gitignore",
]);

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "avif", "bmp"]);

export type ProjectFile = {
  path: string;
  content: string;
  language: string;
  encoding?: "utf8" | "base64";
};

export function fileExtension(path: string): string {
  const base = path.toLowerCase().split("/").pop() ?? "";
  if (!base.includes(".")) return "";
  return base.split(".").pop() ?? "";
}

export function isTextPath(path: string): boolean {
  const ext = fileExtension(path);
  if (!ext) return true;
  return TEXT_EXTENSIONS.has(ext);
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(path));
}

export function contentTypeForPath(path: string): string {
  const ext = fileExtension(path);
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    avif: "image/avif",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    webmanifest: "application/manifest+json",
    woff: "font/woff",
    woff2: "font/woff2",
  };
  return map[ext] ?? (isTextPath(path) ? "text/plain; charset=utf-8" : "application/octet-stream");
}

export function assertSafeProjectPath(input: string): string {
  const path = safeAgentPath(input);
  if (!path) throw new Error("PATH_INVALID");
  return path;
}

export function withLanguage(file: { path: string; content: string; encoding?: "utf8" | "base64" }): ProjectFile {
  return {
    path: file.path,
    content: file.content,
    language: languageForPath(file.path),
    encoding: file.encoding ?? "utf8",
  };
}

export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileTreeNode[];
};

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const folders = new Map<string, FileTreeNode>();

  const ensureFolder = (folderPath: string): FileTreeNode => {
    const existing = folders.get(folderPath);
    if (existing) return existing;
    const parts = folderPath.split("/");
    const node: FileTreeNode = { name: parts[parts.length - 1], path: folderPath, type: "folder", children: [] };
    folders.set(folderPath, node);
    if (parts.length === 1) {
      root.push(node);
    } else {
      ensureFolder(parts.slice(0, -1).join("/")).children!.push(node);
    }
    return node;
  };

  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  for (const path of sorted) {
    const parts = path.split("/");
    const parent = parts.length > 1 ? ensureFolder(parts.slice(0, -1).join("/")) : null;
    const node: FileTreeNode = { name: parts[parts.length - 1], path, type: "file" };
    if (parent) parent.children!.push(node);
    else root.push(node);
  }

  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) if (node.children) sortNodes(node.children);
  };
  sortNodes(root);
  return root;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function isValidDeploySlug(input: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(input) || /^[a-z0-9]{3,40}$/.test(input);
}

export function looksLikeFrameworkProject(paths: string[]): boolean {
  return paths.some((path) =>
    /(?:^|\/)(?:package\.json|vite\.config\.\w+|next\.config\.\w+|angular\.json|svelte\.config\.\w+)$/i.test(path),
  );
}
