import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getCertificatesPage } from "@/lib/server/queries";
import { Award } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Certificates" };

export default async function CertificatesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { certificates, courses } = await getCertificatesPage(db(), user.uid);

  const certList = certificates;
  const courseMap = new Map(courses.map((c) => [c.id, c.title]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">My Certificates</h1>
        <p className="mt-1 text-ink-2">
          Every certificate has a unique public ID. The public verification page shows only your display
          name, course, date and issuer — never your email, address or DOB.
        </p>
      </div>

      {certList.length === 0 ? (
        <EmptyState
          title="No certificates yet"
          body="Complete a course and pass its quizzes — the certificate is issued automatically."
          action={<Link href="/courses"><span className="mt-2 inline-block text-sm font-semibold text-accent">Browse courses →</span></Link>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {certList.map((c) => (
            <Card key={c.id} className="border-border">
              <div className="flex items-start justify-between">
                <span className="text-ink-3" aria-hidden="true"><Award size={26} strokeWidth={1.2} /></span>
                <Badge className={c.verification_status === "valid" ? "border-success/30 bg-success-soft text-success" : "border-danger/30 bg-danger-soft text-danger"}>
                  {c.verification_status}
                </Badge>
              </div>
              <h2 className="mt-3 font-bold text-ink">{(courseMap.get(c.course_id) as string | undefined) ?? "Course"}</h2>
              <p className="mt-1 font-mono text-sm text-ink-2">{c.certificate_id}</p>
              <p className="mt-1 text-xs text-ink-3">Issued {formatDate(c.issued_at)}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={`/certificate/verify/${c.certificate_id}`} className="text-sm font-semibold text-accent hover:text-accent-2">
                  Public verification page →
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="!p-4 text-sm text-ink-3">
        Issued by <strong className="text-ink-2">MATRIX — THAMJJ13.TOP White Hat Team</strong>. Public verification
        never reveals email, phone, date of birth, birth certificate number, address or school information.
      </Card>
    </div>
  );
}
