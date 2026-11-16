"use client";

import { signOutEverywhere } from "@/lib/client/api";

export function SignOutButton({ label = "Logout" }: { label?: string }) {
  async function signOut() {
    await signOutEverywhere();
    // Hard navigation clears any in-memory React state before the next login.
    window.location.replace("/login");
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
