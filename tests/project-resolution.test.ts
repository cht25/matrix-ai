import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/firebase/admin";
import { resolveAgentProject, wantsNewProject } from "@/lib/server/project-resolution";

const user = { uid: "owner", email: "owner@example.com", emailVerified: true };
function fixture() {
  const docs = new Map<string, Record<string, unknown>>([
    ["conversations/c1", { user_id: "owner", active_project_id: "p1" }],
    ["conversations/c2", { user_id: "owner" }],
    ["projects/p1", { owner_id: "owner", conversation_id: "c1", title: "Portfolio Site" }],
    ["projects/p2", { owner_id: "owner", conversation_id: "c2", title: "Second Store" }],
    ["projects/foreign", { owner_id: "attacker", title: "Other" }],
  ]);
  const db = { collection: (kind: string) => ({
    doc: (id: string) => ({ get: async () => ({ exists: docs.has(`${kind}/${id}`), data: () => docs.get(`${kind}/${id}`) }) }),
    where: (key: string, _op: string, val: unknown) => ({ get: async () => ({ docs: [...docs].filter(([path, data]) => path.startsWith(`${kind}/`) && data[key] === val).map(([path, data]) => ({ id: path.split("/").at(-1)!, data: () => data })) }) }),
  }) } as unknown as Db;
  return { db, docs };
}

describe("Agent project resolution across sequential turns", () => {
  it("uses explicit id, then active conversation, then linked project", async () => {
    const { db, docs } = fixture();
    expect(await resolveAgentProject(db, user, { projectId: "p2", conversationId: "c1", prompt: "change theme" })).toBe("p2");
    for (const prompt of ["change theme", "add a section", "fix responsive navbar", "update footer"]) {
      expect(await resolveAgentProject(db, user, { conversationId: "c1", prompt })).toBe("p1");
    }
    docs.set("conversations/c1", { user_id: "owner" });
    expect(await resolveAgentProject(db, user, { conversationId: "c1", prompt: "edit colors" })).toBe("p1");
  });
  it("never edits a foreign or ambiguous project, or invents one for an edit", async () => {
    const { db, docs } = fixture();
    await expect(resolveAgentProject(db, user, { projectId: "foreign", prompt: "edit" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(resolveAgentProject(db, user, { prompt: "change the theme" })).rejects.toMatchObject({ code: "PROJECT_REQUIRED" });
    docs.set("projects/p3", { owner_id: "owner", title: "Third Site", conversation_id: "c2" });
    await expect(resolveAgentProject(db, user, { conversationId: "c2", prompt: "edit site" })).rejects.toMatchObject({ code: "PROJECT_AMBIGUOUS" });
    expect(await resolveAgentProject(db, user, { prompt: "Create a professional portfolio website" })).toBeNull();
  });
  it("honors an explicit new-project request even in a project-linked conversation", async () => {
    const { db } = fixture();
    expect(wantsNewProject("Create another website for my shop")).toBe(true);
    expect(await resolveAgentProject(db, user, { conversationId: "c1", projectId: "p1", prompt: "Create another website for my shop" })).toBeNull();
  });
  it("accepts a unique project name but never another owner's title", async () => {
    const { db } = fixture();
    expect(await resolveAgentProject(db, user, { prompt: "Update Portfolio Site navbar" })).toBe("p1");
    await expect(resolveAgentProject(db, user, { prompt: "Edit Other" })).rejects.toMatchObject({ code: "PROJECT_REQUIRED" });
  });
});
