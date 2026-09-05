"use client";

import { useState } from "react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { Alert, Button, Card, Field, Input, Select, Spinner, Textarea } from "@/components/ui";

export function CourseEditor() {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState("beginner");
  const [status, setStatus] = useState("draft");
  const [moduleTitle, setModuleTitle] = useState("");
  const [lessonTitle, setLessonTitle] = useState("");
  const [lessonBody, setLessonBody] = useState("");
  const [quizTitle, setQuizTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("True\nFalse");
  const [correct, setCorrect] = useState("0");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const optionList = options.split("\n").map((s) => s.trim()).filter(Boolean);
      const result = await rpc<{ id: string; slug: string }>("course_upsert", {
        title,
        slug: slug || title,
        description,
        level,
        status,
        modules: moduleTitle ? [{
          title: moduleTitle,
          lessons: lessonTitle ? [{ title: lessonTitle, summary: "", body: lessonBody }] : [],
          quiz: quizTitle ? {
            title: quizTitle,
            pass_percent: 60,
            questions: question ? [{ question, options: optionList, correct_index: Number(correct) || 0 }] : [],
          } : undefined,
        }] : [],
      });
      setMsg(`Saved course ${result.slug}. Learners only see it when status is published. Correct answers stay server-side.`);
      setTitle(""); setSlug(""); setDescription(""); setModuleTitle(""); setLessonTitle(""); setLessonBody(""); setQuizTitle(""); setQuestion("");
    } catch (err) {
      setMsg(friendly(err, "Save failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="font-bold text-ink">Create a course</h2>
      <p className="mt-1 text-sm text-ink-2">Adds a course, optional module, lesson and quiz. Quiz answers are stored only in the server-side quiz_answers collection.</p>
      <form onSubmit={save} className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" htmlFor="c-title"><Input id="c-title" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
          <Field label="Slug" htmlFor="c-slug"><Input id="c-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="safe-passwords" /></Field>
          <Field label="Level" htmlFor="c-level">
            <Select id="c-level" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="beginner">beginner</option>
              <option value="intermediate">intermediate</option>
              <option value="advanced">advanced</option>
            </Select>
          </Field>
          <Field label="Status" htmlFor="c-status">
            <Select id="c-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="draft">draft</option>
              <option value="published">published</option>
            </Select>
          </Field>
        </div>
        <Field label="Description" htmlFor="c-desc"><Textarea id="c-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></Field>
        <Field label="First module title" htmlFor="m-title"><Input id="m-title" value={moduleTitle} onChange={(e) => setModuleTitle(e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lesson title" htmlFor="l-title"><Input id="l-title" value={lessonTitle} onChange={(e) => setLessonTitle(e.target.value)} /></Field>
          <Field label="Quiz title" htmlFor="q-title"><Input id="q-title" value={quizTitle} onChange={(e) => setQuizTitle(e.target.value)} /></Field>
        </div>
        <Field label="Lesson body (markdown)" htmlFor="l-body"><Textarea id="l-body" value={lessonBody} onChange={(e) => setLessonBody(e.target.value)} rows={5} /></Field>
        <Field label="Quiz question" htmlFor="q-q"><Input id="q-q" value={question} onChange={(e) => setQuestion(e.target.value)} /></Field>
        <Field label="Options (one per line)" htmlFor="q-opt"><Textarea id="q-opt" value={options} onChange={(e) => setOptions(e.target.value)} rows={3} /></Field>
        <Field label="Correct option index (0-based)" htmlFor="q-ok"><Input id="q-ok" inputMode="numeric" value={correct} onChange={(e) => setCorrect(e.target.value)} /></Field>
        {msg ? <Alert tone="info">{msg}</Alert> : null}
        <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Save course"}</Button>
      </form>
    </Card>
  );
}

/** Internal code -> human sentence. The raw code stays in the console only. */
function friendly(err: unknown, fallback: string): string {
  const view = mapAdminError(errorCodeOf(err, fallback));
  console.error("[MATRIX admin]", view.code, err);
  return `${view.title} — ${view.detail}`;
}
