import { useState } from "react";
import { useRouter } from "next/router";
import { useStore } from "./_app";
import { uid } from "../lib/store";

export default function Login() {
  const { state, setState } = useStore();
  const router = useRouter();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");

  function submit(e) {
    e.preventDefault();
    setErr("");
    if (mode === "login") {
      const u = state.users.find(
        (x) => x.email.toLowerCase() === email.toLowerCase() && x.password === password
      );
      if (!u) return setErr("Invalid email or password.");
      if (u.banned) return setErr("This account is banned.");
      setState((s) => ({ ...s, session: u.id }));
      router.replace("/");
      return;
    }
    if (!name.trim()) return setErr("Name required.");
    if (state.users.some((x) => x.email.toLowerCase() === email.toLowerCase()))
      return setErr("Email already registered.");
    const u = {
      id: uid("u"),
      name: name.trim(),
      email: email.trim(),
      password,
      role: "user",
      banned: false,
      createdAt: Date.now(),
    };
    setState((s) => ({ ...s, users: [...s.users, u], session: u.id }));
    router.replace("/");
  }

  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <div className="brand-mark" style={{ width: 42, height: 42 }}>
          M
        </div>
        <h1>Matrix AI</h1>
        <p>Cybersecurity command chat. Demo admin: admin@matrix.ai / admin123</p>
        {mode === "register" && (
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {err && <p style={{ color: "var(--danger)", fontSize: 13 }}>{err}</p>}
        <button className="btn btn-primary btn-block" type="submit">
          {mode === "login" ? "Enter grid" : "Create account"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          style={{ marginTop: 8 }}
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "Need an account?" : "Have an account?"}
        </button>
      </form>
    </div>
  );
}
