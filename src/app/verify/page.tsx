"use client";

// Firebase email-action handler: verifies email links
// (?mode=verifyEmail&oobCode=…) and completes OAuth redirects. When the
// verification succeeds we (re)mint the SSR session cookie so server
// components immediately see emailVerified=true.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { applyActionCode, getRedirectResult, reload } from "firebase/auth";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import { mintSessionCookie } from "@/lib/client/api";
import { AuthShell, AuthUnavailable } from "@/components/auth/login-screen";
import { Alert, Button } from "@/components/ui";

function VerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("Verifying your email…");

  useEffect(() => {
    if (!firebaseBrowserConfigured) {
      setStatus("error");
      setMessage("Authentication is not configured on this deployment yet.");
      return;
    }
    const next = params.get("next") ?? "/chat";
    const mode = params.get("mode");
    const oobCode = params.get("oobCode");
    const auth = fbAuth();

    async function verify() {
      try {
        if (mode === "verifyEmail" && oobCode) {
          await applyActionCode(auth, oobCode);
          if (auth.currentUser) await reload(auth.currentUser).catch(() => {});
        } else if (mode === "resetPassword" && oobCode) {
          window.location.replace(`/reset-password?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}`);
          return;
        } else {
          // OAuth redirect completion (or an already-signed-in visitor).
          await getRedirectResult(auth).catch(() => {});
          const user = auth.currentUser;
          if (!user) {
            setStatus("error");
            setMessage("No verification link found. Check the link from your email, or sign in.");
            return;
          }
        }
        await mintSessionCookie().catch(() => {});
        setStatus("done");
        setMessage("Your email is verified. Welcome to MATRIX!");
        setTimeout(() => router.push(next), 1100);
      } catch {
        setStatus("error");
        setMessage("Verification failed. Please try again with the link from your email.");
      }
    }
    void verify();
  }, [params, router]);

  return (
    <AuthShell title="Verification" subtitle="Confirming your account">
      {status === "working" && <p className="text-center text-sm text-ink-2">{message}</p>}
      {status === "done" && <Alert tone="success">{message}</Alert>}
      {status === "error" && (
        <div className="space-y-4">
          <Alert tone="danger">{message}</Alert>
          <Link href="/login"><Button variant="outline" className="w-full">Go to sign in</Button></Link>
        </div>
      )}
    </AuthShell>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}
