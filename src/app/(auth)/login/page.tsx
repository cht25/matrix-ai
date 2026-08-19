import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginScreen } from "@/components/auth/login-screen";

// App Router page for GET /login (route group `(auth)` does not appear in the
// URL). This is a real server-rendered route — not an Express handler and not
// a client-side SPA path that needs a catch-all rewrite.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginScreen />
    </Suspense>
  );
}
