"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { rpc, RpcCallError } from "@/lib/client/api";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";

export function AdminSetupForm({ seedOnly = false }: { seedOnly?: boolean }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      if (seedOnly) {
        await rpc("admin_seed_rbac");
        setOk("Permission matrix seeded. Open the admin panel.");
        router.refresh();
      } else {
        await rpc("admin_bootstrap", { key });
        router.push("/admin");
        router.refresh();
      }
    } catch (err) {
      const code = errorCodeOf(err, "BOOTSTRAP_FAILED");
      const map: Record<string, string> = {
        BOOTSTRAP_NOT_CONFIGURED: "ADMIN_BOOTSTRAP_KEY is not set on the server.",
        INVALID_BOOTSTRAP_KEY: "That bootstrap key is not correct.",
        BOOTSTRAP_CLOSED: "An administrator already exists.",
        PERMISSION_DENIED: "Only a super_admin can seed the permission matrix.",
      };
      setMsg(map[code] ?? friendly(err, code));
    } finally {
      setBusy(false);
    }
  }

  if (seedOnly) {
    return (
      <form onSubmit={submit} className="card space-y-4 p-5">
        {msg ? <Alert tone="danger">{msg}</Alert> : null}
        {ok ? <Alert tone="info">{ok}</Alert> : null}
        <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Seed admin permissions"}</Button>
      </form>
    );
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

/** Internal code -> human sentence. The raw code stays in the console only. */
function friendly(err: unknown, fallback: string): string {
  const view = mapAdminError(errorCodeOf(err, fallback));
  console.error("[MATRIX]", view.code, err);
  return `${view.title} — ${view.detail}`;
}
