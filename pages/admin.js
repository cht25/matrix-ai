import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useStore } from "./_app";
import { uid } from "../lib/store";

export default function Admin() {
  const { state, ready, setState } = useStore();
  const router = useRouter();
  const me = state.users.find((u) => u.id === state.session);
  const [tab, setTab] = useState("users");
  const [qTitle, setQTitle] = useState("");
  const [qDesc, setQDesc] = useState("");
  const [qJson, setQJson] = useState(
    '[{"q":"What is MFA?","options":["A password","A second factor","A firewall","A hash"],"a":1}]'
  );
  const [certName, setCertName] = useState("Matrix Cyber Foundations");
  const [certHtml, setCertHtml] = useState(DEFAULT_CERT);

  useEffect(() => {
    if (ready && (!me || me.role !== "admin")) router.replace("/");
  }, [ready, me, router]);

  if (!me || me.role !== "admin") return null;

  function ban(id, banned) {
    setState((s) => ({
      ...s,
      users: s.users.map((u) => (u.id === id ? { ...u, banned } : u)),
      session: banned && s.session === id ? null : s.session,
    }));
  }

  function promote(id, role) {
    setState((s) => ({
      ...s,
      users: s.users.map((u) => (u.id === id ? { ...u, role } : u)),
    }));
  }

  function addQuiz() {
    let questions;
    try {
      questions = JSON.parse(qJson);
    } catch {
      alert("Questions must be valid JSON");
      return;
    }
    setState((s) => ({
      ...s,
      quizzes: [
        ...s.quizzes,
        { id: uid("q"), title: qTitle || "Untitled quiz", description: qDesc, questions },
      ],
    }));
    setQTitle("");
    setQDesc("");
    alert("Quiz published");
  }

  function addCert() {
    setState((s) => ({
      ...s,
      certificates: [
        ...s.certificates,
        { id: uid("cert"), name: certName, html: certHtml, createdAt: Date.now() },
      ],
    }));
    alert("Certificate template saved");
  }

  return (
    <div className="admin">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1>Admin panel</h1>
          <p style={{ color: "var(--muted)" }}>Users, bans, roles, all chats, quizzes, certificates</p>
        </div>
        <button className="btn" onClick={() => router.push("/")}>
          Back to chat
        </button>
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="stat">
          <div className="n">{state.users.length}</div>
          Users
        </div>
        <div className="stat">
          <div className="n">{state.chats.length}</div>
          Chats
        </div>
        <div className="stat">
          <div className="n">{state.quizzes.length}</div>
          Quizzes
        </div>
        <div className="stat">
          <div className="n">{state.certificates.length}</div>
          Cert templates
        </div>
      </div>

      <div className="tabs">
        {["users", "chats", "quiz", "certs"].map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "users" && (
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.name}
                  <div style={{ color: "var(--muted)" }}>{u.email}</div>
                </td>
                <td>{u.role}</td>
                <td>{u.banned ? "BANNED" : "active"}</td>
                <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="btn" onClick={() => ban(u.id, !u.banned)}>
                    {u.banned ? "Unban" : "Ban"}
                  </button>
                  {u.role !== "admin" ? (
                    <button className="btn btn-primary" onClick={() => promote(u.id, "admin")}>
                      Promote
                    </button>
                  ) : (
                    u.id !== me.id && (
                      <button className="btn" onClick={() => promote(u.id, "user")}>
                        Demote
                      </button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "chats" && (
        <div>
          {state.chats.length === 0 && <p>No chats yet.</p>}
          {state.chats
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((c) => {
              const owner = state.users.find((u) => u.id === c.userId);
              return (
                <div key={c.id} className="quiz-q">
                  <strong>{c.title}</strong>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {owner?.email || c.userId} · {c.messages.length} messages ·{" "}
                    {new Date(c.updatedAt).toLocaleString()}
                  </div>
                  {c.messages.map((m) => (
                    <div key={m.id} style={{ fontSize: 13, marginTop: 8, whiteSpace: "pre-wrap" }}>
                      <strong>{m.role}:</strong> {m.content}
                    </div>
                  ))}
                </div>
              );
            })}
        </div>
      )}

      {tab === "quiz" && (
        <div className="card" style={{ maxWidth: 720 }}>
          <h2>Add quiz</h2>
          <div className="field">
            <label>Title</label>
            <input value={qTitle} onChange={(e) => setQTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>Description</label>
            <input value={qDesc} onChange={(e) => setQDesc(e.target.value)} />
          </div>
          <div className="field">
            <label>Questions JSON (q, options[], a index)</label>
            <textarea rows={8} value={qJson} onChange={(e) => setQJson(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={addQuiz}>
            Publish quiz
          </button>
          <h3 style={{ marginTop: 20 }}>Existing</h3>
          {state.quizzes.map((q) => (
            <div key={q.id} className="quiz-q">
              <strong>{q.title}</strong>
              <div style={{ color: "var(--muted)" }}>
                {q.description} · {q.questions.length} questions
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "certs" && (
        <div className="card" style={{ maxWidth: 800 }}>
          <h2>Certificate HTML template</h2>
          <p style={{ color: "var(--muted)", marginBottom: 12 }}>
            Placeholders: {"{{name}}"} {"{{course}}"} {"{{date}}"} {"{{score}}"}
          </p>
          <div className="field">
            <label>Template name</label>
            <input value={certName} onChange={(e) => setCertName(e.target.value)} />
          </div>
          <div className="field">
            <label>HTML</label>
            <textarea rows={12} value={certHtml} onChange={(e) => setCertHtml(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={addCert}>
            Save template
          </button>
          {state.certificates.map((c) => (
            <div key={c.id} className="quiz-q">
              {c.name}
            </div>
          ))}
        </div>
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
