"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, RotateCcw, X } from "lucide-react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { Alert, Button, Card } from "@/components/ui";
import { CertificateActions } from "@/components/certificate/certificate-actions";
import type { CertificateData } from "@/components/certificate/certificate-document";
import { cn } from "@/lib/utils";

type Question = { id: string; question: string; explanation: string };
type Option = { id: string; question_id: string; option_text: string };

type QuizResult = {
  score_percent: number;
  passed: boolean;
  results: { question_id: string; selected_option_id: string; correct_option_id: string; correct: boolean }[];
  attempt_id: string;
};

type IssuedCertificate = {
  certificate_id: string;
  course: string;
  display_name: string;
  score_percent: number;
  issued_at: string;
  already_issued: boolean;
};

/** Claim button state machine: idle → generating → ready | failed. */
type ClaimState =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "ready"; cert: CertificateData }
  | { status: "failed"; message: string };

export function QuizClient({
  quizId,
  quizTitle,
  passPercent,
  questions,
  options,
  courseId,
  courseSlug,
  courseTitle,
  bestScore,
}: {
  quizId: string;
  quizTitle: string;
  passPercent: number;
  questions: Question[];
  options: Option[];
  courseId: string;
  courseSlug: string;
  courseTitle?: string;
  bestScore?: number;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimState>({ status: "idle" });

  const allAnswered = questions.every((q) => answers[q.id]);

  const submit = useCallback(async () => {
    if (!allAnswered) return;
    setBusy(true);
    setError(null);
    // Scores are computed server-side (/api/rpc → submit_quiz_attempt) —
    // clients can never fake a result.
    const payload = questions.map((q) => ({ question_id: q.id, option_id: answers[q.id] }));
    try {
      setResult(await rpc<QuizResult>("submit_quiz_attempt", { quiz_id: quizId, answers: payload }));
    } catch (err) {
      const code = err instanceof RpcCallError ? err.code : "SUBMIT_FAILED";
      setError(code === "ATTEMPT_LIMIT_REACHED" ? "You've used all attempts for this quiz." : friendly(err, code));
    } finally {
      setBusy(false);
    }
  }, [allAnswered, answers, questions, quizId]);

  /**
   * Claim the certificate. The server issues (or returns) a persistent
   * certificate with a stable ID — refreshing never mints a new one.
   */
  const claimCertificate = useCallback(async () => {
    setClaim({ status: "generating" });
    try {
      const issued = await rpc<IssuedCertificate>("issue_certificate", { course_id: courseId });
      if (!issued?.certificate_id) throw new RpcCallError("CERTIFICATE_EMPTY", 500);
      setClaim({
        status: "ready",
        cert: {
          certificate_id: issued.certificate_id,
          display_name: issued.display_name,
          course: issued.course || courseTitle || "Course",
          score_percent: issued.score_percent,
          issued_at: issued.issued_at,
          issued_by: "MATRIX — THAMJJ13.TOP White Hat Team",
        },
      });
      router.refresh();
    } catch (err) {
      const code = errorCodeOf(err, "CERTIFICATE_FAILED");
      console.error("[MATRIX] certificate claim failed", code, err);
      // Never surface raw codes, "undefined", "null" or a bare 500.
      const message = code.startsWith("NOT_ELIGIBLE")
        ? `Not eligible yet — ${code.replace(/^NOT_ELIGIBLE:\s*/, "").trim() || "finish the remaining lessons and quizzes first"}.`
        : "Unable to generate your certificate. Please try again.";
      setClaim({ status: "failed", message });
    }
  }, [courseId, courseTitle, router]);

  // ---------------------------------------------------------------- results --
  if (result) {
    const correctCount = result.results.filter((r) => r.correct).length;
    const best = Math.max(bestScore ?? 0, result.score_percent);

    return (
      <div className="space-y-4">
        <Card className="space-y-5 text-center">
          <div
            className={cn(
              "mx-auto grid h-14 w-14 place-items-center rounded-full",
              result.passed ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
            )}
            aria-hidden="true"
          >
            {result.passed ? <Check size={26} strokeWidth={2.2} /> : <RotateCcw size={24} strokeWidth={2} />}
          </div>

          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-ink">{result.passed ? "You passed" : "Keep going"}</h2>
            <p className="text-4xl font-semibold tracking-tight text-ink sm:text-5xl">{result.score_percent}%</p>
            <p className="text-sm text-ink-2">
              {correctCount} / {questions.length} correct · {passPercent}% needed to pass
            </p>
            {best > 0 ? <p className="text-xs text-ink-3">Your best score: {best}%</p> : null}
          </div>
        </Card>

        <Card className="space-y-2">
          {questions.map((q) => {
            const r = result.results.find((x) => x.question_id === q.id);
            const selected = options.find((o) => o.id === r?.selected_option_id);
            const correct = options.find((o) => o.id === r?.correct_option_id);
            return (
              <div key={q.id} className="flex gap-3 border-b border-border py-3 last:border-0 last:pb-0 first:pt-0">
                <span
                  className={cn("mt-0.5 shrink-0", r?.correct ? "text-success" : "text-danger")}
                  aria-hidden="true"
                >
                  {r?.correct ? <Check size={16} strokeWidth={2.2} /> : <X size={16} strokeWidth={2.2} />}
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-ink">{q.question}</p>
                  <p className="text-xs text-ink-2">
                    {r?.correct ? (
                      "Correct"
                    ) : (
                      <>
                        Your answer: <strong className="text-ink">{selected?.option_text ?? "—"}</strong> · Correct:{" "}
                        <strong className="text-ink">{correct?.option_text}</strong>
                      </>
                    )}
                  </p>
                  {q.explanation ? <p className="text-xs text-ink-3">{q.explanation}</p> : null}
                </div>
              </div>
            );
          })}
        </Card>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setResult(null);
              setAnswers({});
              setClaim({ status: "idle" });
            }}
          >
            <RotateCcw size={15} strokeWidth={1.8} aria-hidden="true" /> Retake quiz
          </Button>
          <Button variant="outline" onClick={() => router.push(`/courses/${courseSlug}`)}>
            Back to course
          </Button>
        </div>

        {result.passed ? (
          <Card className="space-y-3">
            <div>
              <p className="eyebrow">Certificate</p>
              <h3 className="mt-1 text-base font-semibold text-ink">
                {claim.status === "ready" ? "Certificate ready" : "Claim your certificate"}
              </h3>
              <p className="mt-1 text-sm text-ink-2">
                {claim.status === "ready"
                  ? "Your certificate is saved to your account with a permanent ID — it stays available after you refresh or sign in again."
                  : "Certificates are issued once you have completed every lesson and passed every quiz in this course."}
              </p>
            </div>

            {claim.status === "ready" ? (
              <>
                <p className="mono text-sm text-success">{claim.cert.certificate_id}</p>
                <CertificateActions cert={claim.cert} />
              </>
            ) : (
              <>
                <Button
                  onClick={() => void claimCertificate()}
                  disabled={claim.status === "generating"}
                  aria-busy={claim.status === "generating"}
                >
                  {claim.status === "generating" ? "Generating…" : "Claim certificate"}
                </Button>
                {claim.status === "failed" ? (
                  <Alert tone="danger">
                    <span className="flex flex-wrap items-center gap-3">
                      {claim.message}
                      <button type="button" className="btn btn-outline" onClick={() => void claimCertificate()}>
                        Retry
                      </button>
                    </span>
                  </Alert>
                ) : null}
              </>
            )}
          </Card>
        ) : null}
      </div>
    );
  }

  // ------------------------------------------------------------------ quiz --
  return (
    <Card className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">{quizTitle}</h2>
        <p className="mt-1 text-sm text-ink-3">
          You need {passPercent}% to pass. Scoring happens server-side.
        </p>
      </div>

      {questions.map((q, qi) => (
        <fieldset key={q.id} className="space-y-2">
          <legend className="mb-1 font-medium text-ink">
            {qi + 1}. {q.question}
          </legend>
          {options
            .filter((o) => o.question_id === q.id)
            .map((o) => (
              <label
                key={o.id}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-[8px] border px-4 py-2.5 text-sm transition-colors",
                  answers[q.id] === o.id
                    ? "border-accent bg-accent-soft font-medium text-ink"
                    : "border-border bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink",
                )}
              >
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
      <Button onClick={() => void submit()} disabled={!allAnswered || busy} aria-busy={busy} className="w-full">
        {busy
          ? "Scoring…"
          : allAnswered
            ? "Submit quiz"
            : `Answer all questions (${Object.keys(answers).length}/${questions.length})`}
      </Button>
    </Card>
  );
}

/** Internal code -> human sentence. The raw code stays in the console only. */
function friendly(err: unknown, fallback: string): string {
  const view = mapAdminError(errorCodeOf(err, fallback));
  console.error("[MATRIX]", view.code, err);
  return `${view.title} — ${view.detail}`;
}
