import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDataClient, getCurrentUser } from "@/lib/data";
import { QuizClient } from "@/components/quiz-client";

export const metadata: Metadata = { title: "Quiz" };

export default async function QuizPage({ params }: { params: Promise<{ slug: string; quizId: string }> }) {
  const { slug, quizId } = await params;
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  if (!user) redirect("/login");

  const { data: quiz } = await db.from("quizzes").select("id, title, pass_percent").eq("id", quizId).maybeSingle();
  if (!quiz) notFound();

  const course = await db.from("courses").select("id, slug, title").eq("slug", slug).eq("status", "published").maybeSingle();
  if (!course.data) notFound();

  const [{ data: questions }, { data: options }] = await Promise.all([
    db.from("quiz_questions").select("id, question, explanation").eq("quiz_id", quizId).order("sort_order"),
    db.from("quiz_options_public").select("id, question_id, option_text").order("sort_order"),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href={`/courses/${slug}`} className="text-sm font-medium text-accent hover:text-accent-2">← {course.data.title}</Link>
      <QuizClient
        quizId={quizId}
        quizTitle={quiz.title}
        passPercent={quiz.pass_percent}
        questions={(questions?.data ?? questions ?? []) as { id: string; question: string; explanation: string }[]}
        options={(options?.data ?? options ?? []) as { id: string; question_id: string; option_text: string }[]}
        courseId={course.data.id}
        courseSlug={slug}
      />
    </div>
  );
}
