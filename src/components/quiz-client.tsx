"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Badge, Button, Card } from "@/components/ui";

type Question = { id: string; question: string; explanation: string };
type Option = { id: string; question_id: string; option_text: string };

export function QuizClient({
  quizId,
  quizTitle,
  passPercent,
  questions,
  options,
  courseId,
  courseSlug,
}: {
  quizId: string;
  quizTitle: string;
  passPercent: number;
  questions: Question[];
  options: Option[];
  courseId: string;
  courseSlug: string;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{
    score_percent: number;
    passed: boolean;
    results: { question_id: string; selected_option_id: string; correct_option_id: string; correct: boolean }[];
    attempt_id: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allAnswered = questions.every((q) => answers[q.id]);

  async function submit() {
    if (!allAnswered) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const payload = questions.map((q) => ({ question_id: q.id, option_id: answers[q.id] }));
    const { data, error } = await supabase.rpc("submit_quiz_attempt", { p_quiz_id: quizId, p_answers: payload });
    setBusy(false);
    if (error) {
      setError(error.message === "ATTEMPT_LIMIT_REACHED" ? "You've used all attempts for this quiz." : error.message);
      return;
    }
    setResult(data as typeof result);
  }

  async function issueCertificate() {
    setBusy(true);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("issue_certificate", { p_course_id: courseId });
    setBusy(false);
    if (error) {
      setError("Certificate not available yet: " + error.message.replace("NOT_ELIGIBLE: ", ""));
      return;
    }
    router.push("/certificate");
    router.refresh();
  }

  if (result) {
    const correctCount = result.results.filter((r) => r.correct).length;
    return (
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold text-ink">{result.passed ? "🎉 You passed!" : "Keep going — try again!"}</h2>
          <Badge className={result.passed ? "border-success/30 bg-success-soft text-success" : "border-warning/30 bg-warning-soft text-warning"}>
            {result.score_percent}% (needed {passPercent}%)
          </Badge>
        </div>
        <p className="text-sm text-ink-2">
          You answered {correctCount} of {questions.length} correctly. Your best score is what counts — you can retake the quiz.
        </p>
        <div className="space-y-3">
          {questions.map((q) => {
            const r = result.results.find((x) => x.question_id === q.id);
            const selected = options.find((o) => o.id === r?.selected_option_id);
            const correct = options.find((o) => o.id === r?.correct_option_id);
            return (
              <div key={q.id} className={`rounded-xl border px-4 py-3 ${r?.correct ? "border-success/30 bg-success-soft/50" : "border-danger/30 bg-danger-soft/50"}`}>
                <p className="font-medium text-ink">{r?.correct ? "✅" : "❌"} {q.question}</p>
                <p className="mt-1 text-sm text-ink-2">
                  {r?.correct ? "Correct!" : <>Your answer: <strong>{selected?.option_text ?? "—"}</strong> · Correct: <strong>{correct?.option_text}</strong></>}
                </p>
                {q.explanation ? <p className="mt-1 text-xs text-ink-3">💡 {q.explanation}</p> : null}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => { setResult(null); setAnswers({}); }}>Retake quiz</Button>
          <Button onClick={() => router.push(`/courses/${courseSlug}`)}>Back to course</Button>
          {result.passed ? <Button onClick={() => void issueCertificate()} disabled={busy}>🏅 Claim your certificate</Button> : null}
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-6">
      <div>
        <h2 className="text-xl font-extrabold text-ink">{quizTitle}</h2>
        <p className="mt-1 text-sm text-ink-3">You need {passPercent}% to pass. Scoring happens server-side — no shortcuts! 😉</p>
      </div>

      {questions.map((q, qi) => (
        <fieldset key={q.id} className="space-y-2.5">
          <legend className="font-semibold text-ink">{qi + 1}. {q.question}</legend>
          {options.filter((o) => o.question_id === q.id).map((o) => (
            <label key={o.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-2.5 text-sm transition-colors ${answers[q.id] === o.id ? "border-accent bg-accent-soft font-medium text-ink" : "border-border bg-surface text-ink-2 hover:bg-bg"}`}>
              <input
                type="radio"
                name={q.id}
                value={o.id}
                checked={answers[q.id] === o.id}
                onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.id }))}
                className="accent-accent"
              />
              {o.option_text}
            </label>
          ))}
        </fieldset>
      ))}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button onClick={() => void submit()} disabled={!allAnswered || busy} className="w-full">
        {busy ? "Scoring…" : allAnswered ? "Submit quiz" : `Answer all questions (${Object.keys(answers).length}/${questions.length})`}
      </Button>
    </Card>
  );
}
