// Server-side probe of the deployed *web* Firebase config (the public
// NEXT_PUBLIC_FIREBASE_* values). The API key should resolve to the Identity
// Toolkit project config; a 400 CONFIGURATION_NOT_FOUND means the key belongs
// to no active Firebase project (typo, deleted key, deleted project, or
// values copied from another app). Used by /api/health so operators can tell
// "bad web key" apart from other failures without opening the browser console.
//
// The key is public by design (it ships in every page bundle), so requesting
// this endpoint server-side leaks nothing.

import { env, isConfigured } from "@/lib/env";

export type WebConfigStatus =
  | "valid" // key resolves to the configured project
  | "invalid-key" // key resolves to no Firebase project at all
  | "project-mismatch" // key resolves, but to a different projectId than env
  | "not-configured" // env vars missing/placeholder
  | "unknown"; // probe failed (network) — inconclusive

export type WebConfigCheck = {
  status: WebConfigStatus;
  /** Project the key actually points at, when it differs from the env value. */
  reportedProjectId?: string;
};

export async function checkWebFirebaseConfig(): Promise<WebConfigCheck> {
  if (!isConfigured()) return { status: "not-configured" };
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(env.firebasePublic.apiKey)}`,
      { signal: AbortSignal.timeout(4000), cache: "no-store" },
    );
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { projectId?: string };
      if (body.projectId && env.firebasePublic.projectId && body.projectId !== env.firebasePublic.projectId) {
        return { status: "project-mismatch", reportedProjectId: body.projectId };
      }
      return { status: "valid" };
    }
    // getProjectConfig only rejects with 400/403 when the key is unusable —
    // including CONFIGURATION_NOT_FOUND for a key tied to no project.
    if (res.status === 400 || res.status === 403) return { status: "invalid-key" };
    return { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}
