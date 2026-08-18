import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Certificates" };

export default async function CertificatesPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const [{ data: certs }, { data: courses }] = await Promise.all([
    db.from("certificates").select("id, certificate_id, course_id, issued_at, verification_status").eq("user_id", user!.id).order("issued_at", { ascending: false }),
    db.from("courses").select("id, title, slug"),
  ]);

  const certList = (certs?.data ?? certs ?? []) as { id: string; certificate_id: string; course_id: string; issued_at: string; verification_status: string }[];
  const courseMap = new Map((courses?.data ?? courses ?? []).map((c: { id: string; title: string }) => [c.id, c.title]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">My Certificates</h1>
        <p className="mt-1 text-slate-500">
          Every certificate has a unique public ID. Anyone can verify it at the public verification page —
          which shows only your display name, course, date and issuer. Never your email, address or DOB.
        </p>
      </div>

      {certList.length === 0 ? (
        <EmptyState
          title="No certificates yet"
          body="Complete a course and pass its quizzes — the certificate is issued automatically."
          action={<Link href="/courses" className="mt-2 text-sm font-semibold text-brand-600">Browse courses →</Link>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {certList.map((c) => (
            <Card key={c.id} className="border-brand-100 bg-gradient-to-br from-white to-brand-50">
              <div className="flex items-start justify-between">
                <span className="text-3xl" aria-hidden="true">🏅</span>
                <Badge className={c.verification_status === "valid" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}>
                  {c.verification_status}
                </Badge>
              </div>
              <h2 className="mt-3 font-bold text-slate-900">{(courseMap.get(c.course_id) as string | undefined) ?? "Course"}</h2>
              <p className="mt-1 font-mono text-sm text-slate-500">{c.certificate_id}</p>
              <p className="mt-1 text-xs text-slate-400">Issued {formatDate(c.issued_at)}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={`/certificate/verify/${c.certificate_id}`} className="text-sm font-semibold text-brand-600 hover:text-brand-700">
                  Public verification page →
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="!p-4 text-sm text-slate-500">
        Issued by <strong className="text-slate-700">MATRIX AI — THAMJJ13.TOP White Hat Team</strong>. Public verification
        never reveals email, phone, date of birth, birth certificate number, address or school information.
      </Card>
    </div>
  );
}
