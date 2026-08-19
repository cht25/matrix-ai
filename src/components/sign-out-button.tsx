"use client";

import { useRouter } from "next/navigation";
import { signOutEverywhere } from "@/lib/client/api";

export function SignOutButton({ label = "Logout" }: { label?: string }) {
  const router = useRouter();
  async function signOut() {
    await signOutEverywhere();
    router.push("/");
    router.refresh();
  }
  return (
    <button
      onClick={() => void signOut()}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger-soft"
    >
      {label}
    </button>
  );
}
