import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { LoginScreen } from "@/components/auth/login-screen";

// Root: unauthenticated users see the professional MATRIX login;
// authenticated users go straight into the app (spec §4, §61).
export default async function HomePage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (user || demo) redirect("/chat");
  return <LoginScreen />;
}
