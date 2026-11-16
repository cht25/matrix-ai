"use client";

import { useRouter } from "next/navigation";
import { rpc } from "@/lib/client/api";
import { useDialogs } from "@/components/dialogs";
import { Button } from "@/components/ui";

export function RevokeSessionButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const dialogs = useDialogs();
  async function revoke() {
    const confirmed = await dialogs.confirm({
      title: "Revoke this session?",
      body: "That device is signed out straight away and has to sign in again.",
      confirmLabel: "Revoke",
    });
    if (!confirmed) return;
    await rpc("revoke_session", { session_id: sessionId }).catch(() => {});
    router.refresh();
  }
  return (
    <>
      <Button variant="outline" onClick={() => void revoke()} className="!px-3 !py-1.5 text-xs">Revoke</Button>
      {dialogs.element}
    </>
  );
}
