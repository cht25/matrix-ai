import { redirect } from "next/navigation";
import { getDataClient, getCurrentUser } from "@/lib/data";
import { LoginScreen } from "@/components/auth/login-screen";
import { isConfigured } from "@/lib/env";
import { ServerProblemScreen } from "@/components/server-problem";

// Root: unauthenticated users see the professional MATRIX login;
// authenticated users go straight into the app (spec §4, §61).
// Rendered per-request — the redirect depends on the real session.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!isConfigured()) {
    return <ServerProblemScreen kind="config" />;
  }
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  if (user) redirect("/chat");
  return <LoginScreen />;
}
