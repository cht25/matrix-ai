import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useStore } from "./_app";
import { uid } from "../lib/store";

export default function QuizPage() {
  const { state, ready, setState } = useStore();
  const router = useRouter();
  const me = state.users.find((u) => u.id === state.session);
  const [pick, setPick] = useState(null);
  const [answers, setAnswers] = useState({});
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (ready && !state.session) router.replace("/login");
  }, [ready, state.session, router]);

  if (!me) return null;

  function grade() {
    const quiz = state.quizzes.find((q) => q.id === pick);
    let ok = 0;
    quiz.questions.forEach((qq, i) => {
      if (answers[i] === qq.a) ok++;
    });
    const score = Math.round((ok / quiz.questions.length) * 100);
    const attempt = {
      id: uid("att"),
      userId: me.id,
      quizId: quiz.id,
      score,
      at: Date.now(),
    };
    setState((s) => ({ ...s, attempts: [...s.attempts, attempt] }));
    setDone({ score, quiz });
  }

  return (
    <div className="admin">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>Cyber quizzes</h1>
        <button className="btn" onClick={() => router.push("/")}>
          Chat
        </button>
      </div>
      {!pick &&
        state.quizzes.map((q) => (
          <div key={q.id} className="quiz-q">
            <strong>{q.title}</strong>
            <p style={{ color: "var(--muted)" }}>{q.description}</p>
            <button className="btn btn-primary" onClick={() => setPick(q.id)}>
              Start
            </button>
          </div>
        ))}
      {pick && !done && (
        <div>
          {state.quizzes
            .find((q) => q.id === pick)
            .questions.map((qq, i) => (
              <div key={i} className="quiz-q">
                <strong>
                  {i + 1}. {qq.q}
                </strong>
                {qq.options.map((o, j) => (
                  <button
                    key={j}
                    className={`opt ${answers[i] === j ? "good" : ""}`}
                    onClick={() => setAnswers({ ...answers, [i]: j })}
                  >
                    {o}
                  </button>
                ))}
              </div>
            ))}
          <button className="btn btn-primary" onClick={grade}>
            Submit
          </button>
        </div>
      )}
      {done && (
        <div className="card">
          <h2>Score: {done.score}%</h2>
          <p>Pass ≥ 70% to issue a certificate from the Certs page.</p>
          <button
            className="btn"
            onClick={() => {
              setPick(null);
              setDone(null);
              setAnswers({});
            }}
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
}
