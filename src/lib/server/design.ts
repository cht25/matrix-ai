// =============================================================================
// MATRIX AI — Dynamic Design Engine persistence (server-only).
//
// Approved designs are stored in Firestore:
//   design_configs/{uid}            → the user's current applied config
//   design_configs/{uid}/versions/{versionId} → full version history
// Preview/validation never writes. Browsers can read their own config only;
// every write happens here through /api/rpc.
// =============================================================================

import "server-only";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/rpc";
import { DEFAULT_DESIGN_TOKENS, designTokensSchema, checkContrast, type DesignTokens } from "@/lib/design/tokens";
import { buildDesignFromInstruction, editDesignTokens } from "@/lib/design/engine";

export { RpcError };

const CONFIGS = "design_configs";

export type DesignConfigRecord = {
  version: number;
  tokens: DesignTokens;
  source: "instruction" | "manual" | "reset";
  summary: string;
  created_at: string;
};

function toRecord(doc: FirebaseFirestore.DocumentSnapshot): DesignConfigRecord {
  const data = doc.data()!;
  return {
    version: Number(data.version ?? 0),
    tokens: data.tokens as DesignTokens,
    source: (data.source as DesignConfigRecord["source"]) ?? "manual",
    summary: String(data.summary ?? ""),
    created_at: data.created_at?.toDate?.().toISOString() ?? "",
  };
}

/** Validate only — used for live preview. Never persists. */
export function previewDesign(input: { instruction?: string; changes?: unknown }) {
  if (input.instruction) return buildDesignFromInstruction(input.instruction);
  return editDesignTokens(DEFAULT_DESIGN_TOKENS, (input.changes ?? {}) as Partial<DesignTokens>);
}

/** Persist an approved config as a new version and make it current. */
export async function saveDesignConfig(
  d: Db,
  user: SessionUser,
  input: { tokens: DesignTokens; source: "instruction" | "manual" | "reset"; summary: string },
): Promise<DesignConfigRecord> {
  const tokens = designTokensSchema.parse(input.tokens);
  const issues = checkContrast(tokens);
  if (issues.length) throw new RpcError("CONTRAST_FAILED");
  const ref = d.collection(CONFIGS).doc(user.uid);
  const current = await ref.get();
  const version = (current.data()?.version ?? 0) + 1;
  const record = {
    version,
    tokens,
    source: input.source,
    summary: input.summary.slice(0, 300),
    created_at: nowTs(),
    updated_at: nowTs(),
  };
  await ref.set(record, { merge: true });
  await ref.collection("versions").doc(String(version)).set(record);
  await d.collection("audit_logs").add({
    actor_id: user.uid,
    action: "design.save",
    target_type: "design_config",
    target_id: user.uid,
    reason: "",
    metadata: { version, source: input.source },
    created_at: nowTs(),
  });
  return { ...record, created_at: record.created_at.toDate().toISOString() };
}

export async function getCurrentDesignConfig(d: Db, uid: string): Promise<DesignConfigRecord | null> {
  const snap = await d.collection(CONFIGS).doc(uid).get();
  if (!snap.exists) return null;
  return toRecord(snap);
}

export async function listDesignVersions(d: Db, uid: string): Promise<DesignConfigRecord[]> {
  const snap = await d.collection(CONFIGS).doc(uid).collection("versions").orderBy("version", "desc").limit(50).get();
  return snap.docs.map(toRecord);
}

export async function applyDesignVersion(d: Db, user: SessionUser, version: number): Promise<DesignConfigRecord> {
  if (!Number.isInteger(version) || version < 1) throw new RpcError("VERSION_INVALID");
  const versionSnap = await d.collection(CONFIGS).doc(user.uid).collection("versions").doc(String(version)).get();
  if (!versionSnap.exists) throw new RpcError("VERSION_NOT_FOUND", 404);
  const record = toRecord(versionSnap);
  const issues = checkContrast(record.tokens);
  if (issues.length) throw new RpcError("CONTRAST_FAILED");
  await d.collection(CONFIGS).doc(user.uid).set(
    { ...versionSnap.data(), updated_at: nowTs() },
    { merge: true },
  );
  return record;
}

export async function resetDesignConfig(d: Db, user: SessionUser): Promise<DesignConfigRecord> {
  return saveDesignConfig(d, user, {
    tokens: DEFAULT_DESIGN_TOKENS,
    source: "reset",
    summary: "Reset to MATRIX default design",
  });
}
