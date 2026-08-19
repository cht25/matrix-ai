import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { env, isGithubConfigured } from "@/lib/env";
import { safeAgentPath, type AgentFile } from "@/lib/ai/agent";

const API = "https://api.github.com";
const CONNECTIONS = "github_connections";

export type GithubConnection = {
  login: string;
  name: string;
  avatarUrl: string;
  connectedAt: string;
};

function encryptionKey(): Buffer {
  return createHash("sha256").update(env.github.tokenEncryptionKey).digest();
}

export function encryptGithubToken(token: string): string {
  if (!isGithubConfigured()) throw new Error("GITHUB_NOT_CONFIGURED");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptGithubToken(value: string): string {
  if (!isGithubConfigured()) throw new Error("GITHUB_NOT_CONFIGURED");
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("GITHUB_TOKEN_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function iso(value: unknown): string {
  const timestamp = value as { toDate?: () => Date } | undefined;
  return timestamp?.toDate?.().toISOString() ?? "";
}

export async function saveGithubConnection(uid: string, token: string, profile: { login: string; name?: string | null; avatar_url?: string | null }) {
  const ref = adminDb().collection(CONNECTIONS).doc(uid);
  const existing = await ref.get();
  const connectedAt = existing.data()?.connected_at ?? nowTs();
  await ref.set({
    user_id: uid,
    access_token_encrypted: encryptGithubToken(token),
    login: profile.login,
    name: profile.name ?? "",
    avatar_url: profile.avatar_url ?? "",
    connected_at: connectedAt,
    updated_at: nowTs(),
  }, { merge: true });
}

export async function getGithubConnection(uid: string): Promise<GithubConnection | null> {
  const doc = await adminDb().collection(CONNECTIONS).doc(uid).get();
  if (!doc.exists) return null;
  const data = doc.data()!;
  return {
    login: String(data.login ?? ""),
    name: String(data.name ?? ""),
    avatarUrl: String(data.avatar_url ?? ""),
    connectedAt: iso(data.connected_at),
  };
}

export async function deleteGithubConnection(uid: string): Promise<void> {
  await adminDb().collection(CONNECTIONS).doc(uid).delete();
}

async function tokenFor(uid: string): Promise<string> {
  const doc = await adminDb().collection(CONNECTIONS).doc(uid).get();
  if (!doc.exists) throw new Error("GITHUB_NOT_CONNECTED");
  return decryptGithubToken(String(doc.data()?.access_token_encrypted ?? ""));
}

export async function githubRequest<T>(uid: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = await tokenFor(uid);
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "MATRIX-AI-Agent",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GITHUB_${response.status}:${detail.slice(0, 180)}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type GithubRepo = {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  permissions: { push: boolean };
};

export async function listGithubRepos(uid: string): Promise<GithubRepo[]> {
  const repos = await githubRequest<Array<{
    id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
    permissions?: { push?: boolean };
  }>>(uid, "/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100");
  return repos
    .filter((repo) => repo.permissions?.push !== false)
    .map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      permissions: { push: repo.permissions?.push !== false },
    }));
}

function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function validBranch(branch: string): boolean {
  const forbidden = [" ", "\t", "\n", "~", "^", ":", "?", "*", "[", "\\"];
  return branch.length > 0 && branch.length <= 180 && !branch.startsWith("-") &&
    !branch.includes("..") && !branch.includes("@{") &&
    !forbidden.some((character) => branch.includes(character)) &&
    !branch.endsWith(".") && !branch.endsWith("/");
}

export function validatePushFiles(input: unknown): AgentFile[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 40) throw new Error("FILES_INVALID");
  const files: AgentFile[] = [];
  let total = 0;
  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw new Error("FILES_INVALID");
    const item = raw as Record<string, unknown>;
    const path = typeof item.path === "string" ? safeAgentPath(item.path) : null;
    const content = typeof item.content === "string" ? item.content : null;
    if (!path || content == null || content.length > 300_000) throw new Error("FILES_INVALID");
    total += content.length;
    if (total > 700_000) throw new Error("FILES_TOO_LARGE");
    files.push({ path, content, language: typeof item.language === "string" ? item.language.slice(0, 30) : "text" });
  }
  return files;
}

/** Create one atomic Git commit and fast-forward the selected branch. */
export async function pushAgentFiles(uid: string, input: {
  repository: string;
  branch: string;
  message: string;
  files: AgentFile[];
}): Promise<{ commitSha: string; commitUrl: string; branch: string }> {
  const { repository, branch } = input;
  if (!validRepo(repository) || !validBranch(branch)) throw new Error("TARGET_INVALID");
  const message = input.message.trim().slice(0, 160);
  if (!message) throw new Error("COMMIT_MESSAGE_REQUIRED");

  // Confirm the connected identity can push before creating any Git objects.
  const repo = await githubRequest<{ permissions?: { push?: boolean }; html_url: string }>(uid, `/repos/${repository}`);
  if (repo.permissions?.push === false) throw new Error("GITHUB_PUSH_FORBIDDEN");

  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  const ref = await githubRequest<{ object: { sha: string } }>(uid, `/repos/${repository}/git/ref/heads/${encodedBranch}`);
  const parentSha = ref.object.sha;
  const parent = await githubRequest<{ tree: { sha: string } }>(uid, `/repos/${repository}/git/commits/${parentSha}`);

  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const file of input.files) {
    const blob = await githubRequest<{ sha: string }>(uid, `/repos/${repository}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
    });
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await githubRequest<{ sha: string }>(uid, `/repos/${repository}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: parent.tree.sha, tree: treeEntries }),
  });
  const commit = await githubRequest<{ sha: string; html_url: string }>(uid, `/repos/${repository}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
  });
  await githubRequest(uid, `/repos/${repository}/git/refs/heads/${encodedBranch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url || `${repo.html_url}/commit/${commit.sha}`,
    branch,
  };
}
