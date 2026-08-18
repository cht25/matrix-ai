"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Button } from "@/components/ui";
import { Logo } from "@/components/logo";

function VerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("Verifying your email…");

  useEffect(() => {
    const next = params.get("next") ?? "/dashboard";
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
          // Possibly already verified (OAuth redirect or confirmation click).
          const { data } = await supabase.auth.getSession();
          if (!data.session) {
            setStatus("error");
            setMessage("No verification link found. Check the link from your email, or sign in.");
            return;
          }
        }
        setStatus("done");
        setMessage("Your email is verified. Welcome to MATRIX AI!");
        setTimeout(() => router.push(next), 1200);
      } catch (e) {
        setStatus("error");
        setMessage(e instanceof Error ? e.message : "Verification failed. Please try again.");
      }
    }
    void verify();
  }, [params, router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4">
      <div className="mb-6"><Logo size="lg" /></div>
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        {status === "working" && <p className="text-slate-600">{message}</p>}
        {status === "done" && <Alert tone="success">{message}</Alert>}
        {status === "error" && (
          <div className="space-y-4">
            <Alert tone="danger">{message}</Alert>
            <Link href="/login"><Button variant="outline" className="w-full">Go to sign in</Button></Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-slate-500">Loading…</div>}>
      <VerifyInner />
    </Suspense>
  );
}
