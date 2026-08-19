import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getQuizPage } from "@/lib/server/queries";
import { QuizClient } from "@/components/quiz-client";

export const metadata: Metadata = { title: "Quiz" };

export default async function QuizPage({ params }: { params: Promise<{ slug: string; quizId: string }> }) {
  const { slug, quizId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await getQuizPage(db(), slug, quizId);
  if (!data) notFound();

  // Options are stored without the correct flag (public-safe, like the old
  // quiz_options_public view); grading happens server-side in /api/rpc.
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href={`/courses/${slug}`} className="text-sm font-medium text-accent hover:text-accent-2">← {data.course.title}</Link>
      <QuizClient
        quizId={quizId}
        quizTitle={data.quiz.title}
        passPercent={data.quiz.pass_percent}
        questions={data.questionList}
        options={data.questions.map((o) => ({ id: o.id, question_id: o.question_id, option_text: o.option_text }))}
        courseId={data.course.id}
        courseSlug={slug}
      />
    </div>
  );
}
