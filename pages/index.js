import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useStore } from "./_app";
import { generateTitle, uid } from "../lib/store";
import { matrixReply } from "../lib/cyber";
import {
  Menu,
  Plus,
  History,
  Shield,
  LogOut,
  Send,
  ImagePlus,
  Paperclip,
  X,
  GraduationCap,
  Award,
  Settings,
  MessageSquare,
} from "lucide-react";

export default function Home() {
  const { state, ready, setState } = useStore();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState("chat"); // chat | history
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const imgRef = useRef(null);

  const me = state.users.find((u) => u.id === state.session);

  useEffect(() => {
    if (ready && !state.session) router.replace("/login");
  }, [ready, state.session, router]);

  useEffect(() => {
    if (me?.banned) {
      alert("This account is banned.");
      setState((s) => ({ ...s, session: null }));
    }
  }, [me, setState]);

  const myChats = useMemo(
    () =>
      state.chats
        .filter((c) => c.userId === state.session)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [state.chats, state.session]
  );

  const active = myChats.find((c) => c.id === activeId) || null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages?.length, view]);

  function ensureChat() {
    if (active) return active;
    const chat = {
      id: uid("chat"),
      userId: state.session,
      title: "New briefing",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setState((s) => ({ ...s, chats: [chat, ...s.chats] }));
    setActiveId(chat.id);
    return chat;
  }

  function readFiles(list) {
    return Promise.all(
      [...list].map(
        (f) =>
          new Promise((res) => {
            const r = new FileReader();
            r.onload = () =>
              res({ name: f.name, type: f.type, dataUrl: r.result, size: f.size });
            r.readAsDataURL(f);
          })
      )
    );
  }

  async function onPick(e) {
    const picked = await readFiles(e.target.files || []);
    setFiles((x) => [...x, ...picked]);
    e.target.value = "";
  }

  function send() {
    const content = text.trim();
    if (!content && !files.length) return;
    const chat = ensureChat();
    const userMsg = {
      id: uid("m"),
      role: "user",
      content,
      attachments: files,
      at: Date.now(),
    };
    const reply = {
      id: uid("m"),
      role: "assistant",
      content: matrixReply(content, files),
      at: Date.now(),
    };
    setState((s) => {
      const chats = s.chats.map((c) => {
        if (c.id !== chat.id) return c;
        const messages = [...c.messages, userMsg, reply];
        return {
          ...c,
          messages,
          title: generateTitle(messages),
          updatedAt: Date.now(),
        };
      });
      return { ...s, chats };
    });
    setText("");
    setFiles([]);
    setView("chat");
  }

  function newChat() {
    setActiveId(null);
    setView("chat");
    setOpen(false);
  }

  if (!ready || !me) {
    return (
      <div className="empty">
        <p>Loading Matrix…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className={`menu-overlay ${open ? "show" : ""}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-head">
          <div className="brand">
            <div className="brand-mark">M</div>
            <div>
              Matrix AI
              <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>
                Sentinel · Cyber
              </div>
            </div>
          </div>
          <button className="icon-btn mobile-only" onClick={() => setOpen(false)}>
            <X size={16} />
          </button>
        </div>
        <div className="sidebar-actions">
          <button className="btn btn-primary btn-block" onClick={newChat}>
            <Plus size={16} /> New chat
          </button>
          <button
            className="btn btn-block"
            onClick={() => {
              setView("history");
              setOpen(false);
            }}
          >
            <History size={16} /> All history
          </button>
        </div>
        <div className="nav-label">All chats</div>
        <div className="chat-list">
          {myChats.length === 0 && (
            <p style={{ color: "var(--muted)", fontSize: 13, padding: "0 10px" }}>
              No conversations yet.
            </p>
          )}
          {myChats.map((c) => (
            <button
              key={c.id}
              className={`chat-item ${c.id === activeId && view === "chat" ? "active" : ""}`}
              onClick={() => {
                setActiveId(c.id);
                setView("chat");
                setOpen(false);
              }}
            >
              <MessageSquare size={14} style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <div className="t">{c.title}</div>
                <div className="s">
                  {c.messages.length} msgs · {new Date(c.updatedAt).toLocaleString()}
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            <strong>{me.name}</strong>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>{me.email}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => router.push("/quiz")}>
              <GraduationCap size={14} /> Quiz
            </button>
            <button className="btn" onClick={() => router.push("/certificate")}>
              <Award size={14} /> Certs
            </button>
            {me.role === "admin" && (
              <button className="btn" onClick={() => router.push("/admin")}>
                <Settings size={14} /> Admin
              </button>
            )}
            <button
              className="btn"
              onClick={() => setState((s) => ({ ...s, session: null }))}
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <button className="icon-btn mobile-only" onClick={() => setOpen(true)}>
              <Menu size={18} />
            </button>
            <Shield size={16} color="#22c55e" />
            <div className="top-title">
              {view === "history" ? "All histories" : active?.title || "New briefing"}
            </div>
          </div>
          <span className="badge">Sentinel · best cyber model</span>
        </header>

        {view === "history" ? (
          <div className="messages">
            <div className="msg-wrap">
              <h2 style={{ marginBottom: 12 }}>Full history</h2>
              <p style={{ color: "var(--muted)", marginBottom: 16 }}>
                Every conversation on this account. Titles are generated from the theme of the chat.
              </p>
              {myChats.map((c) => (
                <div key={c.id} className="quiz-q">
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{c.title}</strong>
                    <button
                      className="btn"
                      onClick={() => {
                        setActiveId(c.id);
                        setView("chat");
                      }}
                    >
                      Open
                    </button>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 10px" }}>
                    {new Date(c.createdAt).toLocaleString()} → {new Date(c.updatedAt).toLocaleString()}
                  </div>
                  {c.messages.map((m) => (
                    <div key={m.id} style={{ fontSize: 13, marginBottom: 8 }}>
                      <strong>{m.role === "user" ? "You" : "Sentinel"}:</strong>{" "}
                      {m.content.slice(0, 240)}
                      {m.content.length > 240 ? "…" : ""}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="messages">
              {!active || active.messages.length === 0 ? (
                <div className="empty">
                  <Shield size={40} color="#22c55e" />
                  <h1>Matrix Sentinel</h1>
                  <p>
                    Ask anything about cybersecurity — IR, AppSec, cloud, IAM, malware defense,
                    detections. Attach screenshots or files right here in the chat.
                  </p>
                  <div className="chips">
                    {[
                      "How do I contain ransomware?",
                      "Explain OWASP broken access control",
                      "Zero Trust for a 200-person SaaS",
                      "Review this phishing screenshot",
                    ].map((s) => (
                      <button key={s} className="chip" onClick={() => setText(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="msg-wrap">
                  {active.messages.map((m) => (
                    <div key={m.id} className={`msg ${m.role}`}>
                      <div className={`avatar ${m.role === "user" ? "user" : "ai"}`}>
                        {m.role === "user" ? "U" : "M"}
                      </div>
                      <div>
                        <div className="bubble">{m.content}</div>
                        {(m.attachments || []).map((a, i) =>
                          a.type?.startsWith("image/") ? (
                            <img key={i} className="attach-preview" src={a.dataUrl} alt={a.name} />
                          ) : (
                            <div key={i} className="hint" style={{ textAlign: "left" }}>
                              📎 {a.name}
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            <div className="composer-wrap">
              <div className="composer">
                {files.length > 0 && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: 6 }}>
                    {files.map((f, i) => (
                      <div key={i} style={{ fontSize: 12, position: "relative" }}>
                        {f.type?.startsWith("image/") ? (
                          <img src={f.dataUrl} alt="" className="attach-preview" style={{ maxWidth: 90 }} />
                        ) : (
                          <span className="badge">{f.name}</span>
                        )}
                        <button
                          className="icon-btn"
                          style={{ position: "absolute", top: -6, right: -6, width: 22, height: 22 }}
                          onClick={() => setFiles(files.filter((_, j) => j !== i))}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  placeholder="Ask Sentinel anything about cyber security…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-bar">
                  <div className="composer-tools">
                    <input ref={imgRef} type="file" accept="image/*" hidden onChange={onPick} />
                    <input ref={fileRef} type="file" multiple hidden onChange={onPick} />
                    <button className="btn" type="button" onClick={() => imgRef.current?.click()}>
                      <ImagePlus size={16} /> Screenshot
                    </button>
                    <button className="btn" type="button" onClick={() => fileRef.current?.click()}>
                      <Paperclip size={16} /> File
                    </button>
                  </div>
                  <button className="btn btn-primary" onClick={send}>
                    <Send size={16} /> Send
                  </button>
                </div>
              </div>
              <div className="hint">
                Screenshots upload in this chat — no extra page. Titles auto-name from the theme of the conversation.
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
