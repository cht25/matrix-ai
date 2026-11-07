import { z } from "zod";

const coordinate = z.number().finite().min(-100_000).max(100_000);
export const canvasNodeSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(["text", "code", "image", "document", "rectangle", "ellipse", "diamond"]),
  x: coordinate, y: coordinate,
  width: z.number().finite().min(100).max(2400),
  height: z.number().finite().min(48).max(2400),
  content: z.string().max(40_000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3897ff"),
}).strict();
export const canvasDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(canvasNodeSchema).max(100),
  edges: z.array(z.object({ id: z.string().min(1).max(80), from: z.string().min(1).max(80), to: z.string().min(1).max(80), label: z.string().max(120).default("") }).strict()).max(200),
  viewport: z.object({ x: coordinate, y: coordinate, zoom: z.number().finite().min(0.25).max(2) }).strict(),
}).strict().superRefine((doc, ctx) => {
  const ids = new Set<string>();
  for (const node of doc.nodes) {
    if (ids.has(node.id)) ctx.addIssue({ code: "custom", message: "Duplicate node ID" });
    ids.add(node.id);
    if (node.type === "image" && node.content) {
      try { const url = new URL(node.content); if (url.protocol !== "https:" || url.username || url.password) throw new Error(); }
      catch { ctx.addIssue({ code: "custom", message: "Images require an HTTPS URL" }); }
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of doc.edges) {
    if (edgeIds.has(edge.id) || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) ctx.addIssue({ code: "custom", message: "Invalid or duplicate connection" });
    edgeIds.add(edge.id);
  }
  if (new TextEncoder().encode(JSON.stringify(doc)).length > 700_000) ctx.addIssue({ code: "custom", message: "Canvas exceeds the storage safety limit" });
});
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;
export type CanvasRecord = { id: string; title: string; project_id: string | null; revision: number; document: CanvasDocument; updated_at: string };
export type CanvasSummary = Pick<CanvasRecord, "id" | "title" | "project_id" | "revision" | "updated_at">;
export const EMPTY_CANVAS: CanvasDocument = { schemaVersion: 1, nodes: [], edges: [], viewport: { x: 40, y: 40, zoom: 1 } };
