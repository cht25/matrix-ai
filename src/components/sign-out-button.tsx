"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Button } from "@/components/ui";

export function SignOutButton({ label = "Sign out" }: { label?: string }) {
  const router = useRouter();
  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <Button variant="ghost" onClick={signOut} className="w-full justify-start !px-3">
      {label}
    </Button>
  );
}
