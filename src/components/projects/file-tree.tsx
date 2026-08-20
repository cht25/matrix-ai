"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, Folder } from "lucide-react";
import { buildFileTree, type FileTreeNode } from "@/lib/projects/paths";
import { cn } from "@/lib/utils";

export function FileTree({
  paths,
  activePath,
  onOpen,
}: {
  paths: string[];
  activePath: string;
  onOpen: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(paths), [paths]);
  if (!paths.length) return <p className="p-2 text-xs text-ink-3">No files yet.</p>;
  return (
    <nav aria-label="Project files" className="space-y-0.5 p-1">
      {tree.map((node) => (
        <TreeNode key={node.path} node={node} activePath={activePath} onOpen={onOpen} depth={0} />
      ))}
    </nav>
  );
}

function TreeNode({
  node, activePath, onOpen, depth,
}: {
  node: FileTreeNode;
  activePath: string;
  onOpen: (path: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(true);
  if (node.type === "folder") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{ paddingLeft: 8 + depth * 12 }}
          className="flex min-h-9 w-full items-center gap-1.5 rounded-md text-left text-xs text-ink-2 hover:bg-surface hover:text-ink"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Folder size={13} className="shrink-0 text-ink-3" />
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {open ? node.children?.map((child) => (
          <TreeNode key={child.path} node={child} activePath={activePath} onOpen={onOpen} depth={depth + 1} />
        )) : null}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(node.path)}
      style={{ paddingLeft: 20 + depth * 12 }}
      className={cn(
        "flex min-h-9 w-full items-center gap-1.5 rounded-md text-left text-xs",
        activePath === node.path ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:bg-surface hover:text-ink",
      )}
    >
      <FileCode2 size={13} className="shrink-0 text-ink-3" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}
