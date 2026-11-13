import "server-only";
import type { Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";

export function wantsNewProject(prompt: string): boolean {
  return /\b(?:create|build|start|make)\b[\s\S]{0,70}\b(?:new|another|separate|different)\s+(?:project|website|web\s?site|site|app|portfolio)\b/i.test(prompt);
}

/** Resolve only owned, non-archived projects. An edit never silently creates a
 * second project or picks an arbitrary item from a list of matches. */
export async function resolveAgentProject(
  d: Db,
  user: SessionUser,
  input: { projectId?: string | null; conversationId?: string | null; prompt: string },
): Promise<string | null> {
  const owned = async (id: string): Promise<boolean> => {
    const snap = await d.collection("projects").doc(id).get();
    return snap.exists && snap.data()?.owner_id === user.uid && !snap.data()?.archived_at;
  };
  // The client may send the currently open project automatically. An explicit
  // "create another/new project" instruction overrides that stale context.
  if (wantsNewProject(input.prompt)) return null;
  if (input.projectId) {
    if (!(await owned(input.projectId))) throw new RpcError("PROJECT_NOT_FOUND", 404);
    return input.projectId;
  }
  if (input.conversationId) {
    const conversation = await d.collection("conversations").doc(input.conversationId).get();
    if (!conversation.exists || conversation.data()?.user_id !== user.uid) throw new RpcError("CONVERSATION_NOT_FOUND", 404);
    const active = conversation.data()?.active_project_id;
    if (typeof active === "string" && await owned(active)) return active;
    const linked = await d.collection("projects").where("conversation_id", "==", input.conversationId).get();
    const mine = linked.docs.filter((doc) => doc.data().owner_id === user.uid && !doc.data().archived_at);
    if (mine.length === 1) return mine[0].id;
    if (mine.length > 1) throw new RpcError("PROJECT_AMBIGUOUS", 409);
  }
  // Project names are hints, not permission to guess. Match only a complete
  // title and require exactly one owned match.
  const projects = await d.collection("projects").where("owner_id", "==", user.uid).get();
  const names = projects.docs.filter((doc) => !doc.data().archived_at && typeof doc.data().title === "string" &&
    doc.data().title.trim().length >= 4 && input.prompt.toLowerCase().includes(doc.data().title.trim().toLowerCase()));
  if (names.length === 1 && /\b(?:edit|update|change|modify|fix|repair|refactor)\b/i.test(input.prompt)) return names[0].id;
  if (names.length > 1) throw new RpcError("PROJECT_AMBIGUOUS", 409);
  // A request to modify existing source without a bound project must not
  // turn into a new project named after the instruction.
  if (/^\s*(?:please\s+)?(?:edit|update|change|modify|fix|repair|refactor|rename|remove|add\s+(?:a|an|the)\s+(?:section|feature|button|form|navbar)|make\s+(?:the|it|this)\s+)/i.test(input.prompt)) {
    throw new RpcError("PROJECT_REQUIRED", 409);
  }
  return null;
}
