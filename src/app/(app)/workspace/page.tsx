import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/data";
import { MATRIX_MODES } from "@/lib/ai/modes";

export const metadata = { title: "Workspace" } as const;

export default async function WorkspacePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <div className="mx-auto max-w-3xl py-6">
      <p className="eyebrow">My workspace</p>
      <h1 className="mt-2 text-2xl font-semibold">Specialized intelligences</h1>
      <p className="mt-2 text-sm text-ink-2">Open a mode without mixing unrelated contexts. Health never shares a coding project automatically.</p>
      <ul className="mt-6 grid gap-2 sm:grid-cols-2">
        {MATRIX_MODES.map((m) => (
          <li key={m.id}>
            <Link href={`/chat?mode=${m.id}&new=${Date.now()}`} className="suggest-card w-full">
              <span>
                <span className="block text-sm font-semibold text-ink">{m.label}</span>
                <span className="block text-[12px] text-ink-3">{m.hint}</span>
              </span>
            </Link>
          </li>
        ))}
        <li>
          <Link href="/projects" className="suggest-card w-full">
            <span>
              <span className="block text-sm font-semibold text-ink">Code projects</span>
              <span className="block text-[12px] text-ink-3">Files, preview, publish</span>
            </span>
          </Link>
        </li>
        <li>
          <Link href="/history" className="suggest-card w-full">
            <span>
              <span className="block text-sm font-semibold text-ink">Recent chats</span>
              <span className="block text-[12px] text-ink-3">Unified history</span>
            </span>
          </Link>
        </li>
      </ul>
    </div>
  );
}
