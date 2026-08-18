"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";
import { AuthShell } from "@/components/auth/login-screen";
import { Alert, Button } from "@/components/ui";

function VerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("Verifying your email…");

  useEffect(() => {
    const next = params.get("next") ?? "/chat";
    const tokenHash = params.get("token_hash");
    const type = params.get("type");
    const code = params.get("code");
    const supabase = createClient();

    async function verify() {
      try {
        if (tokenHash && type) {
          const { error } = await supabase.auth.verifyOtp({ type: type as never, token_hash: tokenHash });
          if (error) throw error;
        } else if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else {
          const { data } = await supabase.auth.getSession();
          if (!data.session) {
            setStatus("error");
            setMessage("No verification link found. Check the link from your email, or sign in.");
            return;
          }
        }
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
