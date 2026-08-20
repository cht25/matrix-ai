"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { rpc, RpcCallError } from "@/lib/client/api";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";

export function AdminSetupForm() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await rpc("admin_bootstrap", { key });
      router.push("/admin");
      router.refresh();
    } catch (err) {
      const code = err instanceof RpcCallError ? err.code : "BOOTSTRAP_FAILED";
      const map: Record<string, string> = {
        BOOTSTRAP_NOT_CONFIGURED: "ADMIN_BOOTSTRAP_KEY is not set on the server.",
        INVALID_BOOTSTRAP_KEY: "That bootstrap key is not correct.",
        BOOTSTRAP_CLOSED: "An administrator already exists.",
      };
      setMsg(map[code] ?? code);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-5">
      <Field label="Bootstrap key" htmlFor="boot" hint="Must match the server ADMIN_BOOTSTRAP_KEY environment variable.">
        <Input id="boot" type="password" value={key} onChange={(e) => setKey(e.target.value)} required />
      </Field>
      {msg ? <Alert tone="danger">{msg}</Alert> : null}
      <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Become super_admin"}</Button>
    </form>
  );
}
