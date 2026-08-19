import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getCourseDetail } from "@/lib/server/queries";
import { Badge, Card, Progress } from "@/components/ui";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Course" };

export default async function CourseDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await getCourseDetail(db(), user.uid, slug);
  if (!data) notFound();
  const course = data.course;
  const cert = data.certificate;

  const modList = data.modules;
  const lessonList = data.lessons;
  const quizList = data.quizzes;
  const progList = data.progress;
  const attList = data.attempts;
  const done = new Set(progList.filter((p) => p.status === "completed").map((p) => p.lesson_id));
  const passedQuizzes = new Set(attList.filter((a) => a.passed).map((a) => a.quiz_id));

  const allLessonIds = lessonList.filter((l) => modList.some((m) => m.id === l.module_id)).map((l) => l.id);
  const pct = allLessonIds.length ? Math.round(([...done].filter((id) => allLessonIds.includes(id)).length / allLessonIds.length) * 100) : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/courses" className="text-sm font-medium text-accent hover:text-accent-2">← All courses</Link>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">{course.title}</h1>
          {cert ? <Badge className="border-success/30 bg-success-soft text-success">✓ Certificate earned</Badge> : null}
        </div>
        <p className="mt-2 text-ink-2">{course.description}</p>
        <div className="mt-4 flex items-center gap-3 text-sm text-ink-3">
          <span className="capitalize">{course.level}</span>·<span>{course.duration_minutes} min</span>·<span className="font-semibold text-ink-2">{pct}% complete</span>
        </div>
        <Progress value={pct} className="mt-2" />
      </div>

      {modList.map((m) => {
        const modLessons = lessonList.filter((l) => l.module_id === m.id);
        const modQuizzes = quizList.filter((q) => q.module_id === m.id);
        const modDone = modLessons.filter((l) => done.has(l.id)).length;
        return (
          <Card key={m.id}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-ink">{m.title}</h2>
              <span className="text-xs text-ink-3">{modDone}/{modLessons.length} lessons</span>
            </div>
            {m.description ? <p className="mt-1 text-sm text-ink-3">{m.description}</p> : null}
            <ul className="mt-3 space-y-1.5">
              {modLessons.map((l) => (
                <li key={l.id}>
                  <Link href={`/courses/${course.slug}/lesson/${l.id}`} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm hover:bg-bg">
                    <span className={cn("w-5 text-center text-[11px]", done.has(l.id) ? "text-success" : "text-ink-3")} aria-hidden="true">{done.has(l.id) ? "✓" : ""}</span>
                    <span className={done.has(l.id) ? "text-ink-3" : "font-medium text-ink"}>{l.title}</span>
                  </Link>
                </li>
              ))}
              {modQuizzes.map((q) => (
                <li key={q.id}>
                  <Link href={`/courses/${course.slug}/quiz/${q.id}`} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm hover:bg-bg">
                    <span aria-hidden="true">{passedQuizzes.has(q.id) ? "" : "Quiz"}</span>
                    <span className={passedQuizzes.has(q.id) ? "text-ink-3" : "font-medium text-ink"}>{q.title}</span>
                    {passedQuizzes.has(q.id) ? <Badge className="border-success/30 bg-success-soft text-success">Passed ✓</Badge> : <Badge className="border-border bg-surface text-ink-3">Needs {q.pass_percent}% to pass</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}

      {cert ? (
        <Card className="border-success/30 bg-success-soft">
          <h2 className="font-bold text-success"> You earned a certificate for this course!</h2>
          <p className="mt-1 font-mono text-sm text-success">{cert.certificate_id}</p>
          <p className="mt-1 text-xs text-success">Issued {cert.issued_at?.slice(0, 10)} · Verify it publicly at /certificate/verify/…</p>
        </Card>
      ) : null}
    </div>
  );
}
