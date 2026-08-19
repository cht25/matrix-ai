import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { useStore } from "./_app";

export default function CertificatePage() {
  const { state, ready } = useStore();
  const router = useRouter();
  const me = state.users.find((u) => u.id === state.session);
  const [tplId, setTplId] = useState("");
  const [html, setHtml] = useState("");

  useEffect(() => {
    if (ready && !state.session) router.replace("/login");
  }, [ready, state.session, router]);

  const best = useMemo(() => {
    const mine = state.attempts.filter((a) => a.userId === state.session);
    if (!mine.length) return null;
    return mine.sort((a, b) => b.score - a.score)[0];
  }, [state.attempts, state.session]);

  const templates = state.certificates.length
    ? state.certificates
    : [
        {
          id: "default",
          name: "Default Matrix certificate",
          html: DEFAULT_CERT,
        },
      ];

  useEffect(() => {
    if (!tplId && templates[0]) setTplId(templates[0].id);
  }, [tplId, templates]);

  if (!me) return null;

  function render() {
    const tpl = templates.find((t) => t.id === tplId) || templates[0];
    const quiz = state.quizzes.find((q) => q.id === best?.quizId);
    const out = tpl.html
      .replaceAll("{{name}}", me.name)
      .replaceAll("{{course}}", quiz?.title || "Matrix Cyber Foundations")
      .replaceAll("{{date}}", new Date().toLocaleDateString())
      .replaceAll("{{score}}", best ? `${best.score}%` : "—");
    setHtml(out);
  }

  return (
    <div className="admin">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>Certificates</h1>
        <button className="btn" onClick={() => router.push("/")}>
          Chat
        </button>
      </div>
      <p style={{ color: "var(--muted)", margin: "8px 0 16px" }}>
        Issued from admin HTML templates. Best quiz score: {best ? `${best.score}%` : "none yet"}.
      </p>
      <div className="field" style={{ maxWidth: 480 }}>
        <label>Template</label>
        <select value={tplId} onChange={(e) => setTplId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <button className="btn btn-primary" onClick={render} disabled={!best || best.score < 70}>
        Generate certificate
      </button>
      {(!best || best.score < 70) && (
        <p style={{ color: "var(--warn)", marginTop: 8 }}>Score at least 70% on a quiz first.</p>
      )}
      {html && (
        <iframe
          title="cert"
          style={{
            width: "100%",
            height: 520,
            marginTop: 16,
            border: "1px solid var(--line)",
            borderRadius: 12,
            background: "#fff",
          }}
          srcDoc={html}
        />
      )}
    </div>
  );
}

const DEFAULT_CERT = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  body { font-family: Georgia, serif; background:#0b1210; color:#e8f5ef; display:flex; justify-content:center; padding:40px; }
  .cert { width: 800px; border: 8px double #22c55e; padding: 48px; text-align:center; background: linear-gradient(#0e1614,#12201b); }
  h1 { letter-spacing:.2em; font-size:28px; color:#22c55e; }
  .name { font-size:36px; margin:24px 0 8px; }
  .meta { color:#7a9a8c; }
</style>
</head>
<body>
  <div class="cert">
    <h1>CERTIFICATE OF COMPLETION</h1>
    <p>Matrix AI · Cybersecurity Academy</p>
    <div class="name">{{name}}</div>
    <p>has successfully completed</p>
    <h2>{{course}}</h2>
    <p class="meta">Score {{score}} · {{date}}</p>
  </div>
</body>
</html>`;
