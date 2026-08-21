// Browser-safe Firebase configuration only. Do not add provider credentials or
// server-side environment variables here: this module is imported by the
// client Firebase SDK and is bundled for the browser.

const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "";
const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "";
const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "";
const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "";
const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "";

const PLACEHOLDERS = ["YOUR-", "your-project", "your-api-key", "your-project-id", "example.com", "replace-with", "..."];
const okApiKey = Boolean(apiKey) && !PLACEHOLDERS.some((p) => apiKey.includes(p));
const okProjectId = Boolean(projectId) && !PLACEHOLDERS.some((p) => projectId.includes(p));

const resolvedAuthDomain = (() => {
  const raw = authDomain.trim();
  if (raw.endsWith(".firebaseapp.com") || raw.endsWith(".web.app")) return raw;
  return projectId ? `${projectId}.firebaseapp.com` : raw;
})();

export const firebasePublic = {
  apiKey,
  authDomain: resolvedAuthDomain,
  projectId,
  messagingSenderId,
  appId,
} as const;

export function isConfigured(): boolean {
  return okApiKey && okProjectId;
}
