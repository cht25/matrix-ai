import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getLessonPage } from "@/lib/server/queries";
import { CompleteLessonButton } from "@/components/complete-lesson-button";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Lesson" };

export default async function LessonPage({ params }: { params: Promise<{ slug: string; lessonId: string }> }) {
  const { slug, lessonId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await getLessonPage(db(), user.uid, slug, lessonId);
  if (!data) notFound();
  const lesson = data.lesson;
  const course = data.course;

  const modList = data.modules;
  const lessonList = data.lessons;
  const isCompleted = data.progress?.status === "completed";

  // Order: lessons of this course, in module/lesson order.
  const ordered = lessonList.filter((l) => modList.some((m) => m.id === l.module_id));
  const idx = ordered.findIndex((l) => l.id === lessonId);
  const prev = idx > 0 ? ordered[idx - 1] : null;
  const next = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null;
  const nextHref = next ? `/courses/${slug}/lesson/${next.id}` : null;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href={`/courses/${slug}`} className="text-sm font-medium text-accent hover:text-accent-2">← {course.title}</Link>

      <Card className="!p-6 sm:!p-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">Lesson {idx + 1} of {ordered.length}</p>
        <h1 className="mt-1 text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">{lesson.title}</h1>
        {lesson.summary ? <p className="mt-2 text-ink-2">{lesson.summary}</p> : null}
        <div className="mt-5 whitespace-pre-line text-[15px] leading-relaxed text-ink">{lesson.body}</div>

        <div className="mt-8 flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          {prev ? (
            <Link href={`/courses/${slug}/lesson/${prev.id}`} className="text-sm font-medium text-ink-3 hover:text-ink">← {prev.title}</Link>
          ) : <span />}
          <div className="flex gap-2">
            {nextHref ? (
              <CompleteLessonButton lessonId={lessonId} completed={isCompleted} nextHref={nextHref} />
            ) : (
              <CompleteLessonButton lessonId={lessonId} completed={isCompleted} nextHref={null} finalLabel="Course complete — well done!" />
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
