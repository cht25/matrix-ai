import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getCoursesOverview } from "@/lib/server/queries";
import { Card, Progress } from "@/components/ui";

export const metadata: Metadata = { title: "Courses" };

export default async function CoursesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Per-course completion: lessons total vs completed.
  const overview = await getCoursesOverview(db(), user.uid);

  const courseList = overview.courses;
  const moduleList = overview.modules;
  const lessonList = overview.lessons;
  const progressList = overview.progress;
  const certList = overview.certificates;
  const doneLessons = new Set(progressList.filter((p) => p.status === "completed").map((p) => p.lesson_id));

  const stats = courseList.map((c) => {
    const modIds = moduleList.filter((m) => m.course_id === c.id).map((m) => m.id);
    const lessonIds = lessonList.filter((l) => modIds.includes(l.module_id)).map((l) => l.id);
    const done = lessonIds.filter((id) => doneLessons.has(id)).length;
    const pct = lessonIds.length ? Math.round((done / lessonIds.length) * 100) : 0;
    const cert = certList.find((x) => x.course_id === c.id);
    return { ...c, lessonCount: lessonIds.length, done, pct, cert };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Cyber Safety Courses</h1>
        <p className="mt-1 text-ink-3">Learn at your own pace. Finish a course, pass its quizzes, and earn a verifiable certificate.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {stats.map((c) => (
          <Link key={c.id} href={`/courses/${c.slug}`}>
            <Card className="h-full transition-shadow hover:shadow-md">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-bold text-ink">{c.title}</h2>
                {c.cert ? <span className="rounded-full border border-success/30 bg-success-soft px-2 py-0.5 text-[10px] font-bold uppercase text-success">✓ Certified</span> : null}
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-ink-2">{c.description}</p>
              <div className="mt-4 flex items-center justify-between text-xs text-ink-3">
                <span className="capitalize">{c.level} · {c.duration_minutes} min · {c.lessonCount} lessons</span>
                <span className="font-semibold text-ink-2">{c.pct}%</span>
              </div>
              <Progress value={c.pct} className="mt-2" />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
