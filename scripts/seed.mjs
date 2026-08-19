#!/usr/bin/env node
// =============================================================================
// MATRIX AI — Firestore seed (port of supabase/migrations/0007_seed.sql).
//
//   node scripts/seed.mjs            seed Firestore
//   node scripts/seed.mjs --dry-run  parse + print counts only
//
// Reads seed/0007_seed.sql (the original SQL seed, kept as the source of
// truth) and writes: countries, admin RBAC (roles/permissions/links), scam
// categories + articles, reporting resources, RAG knowledge chunks, 7 courses
// with modules/lessons/quizzes — and the server-only quiz_answers collection.
//
// Credentials: FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (+ project id),
// Google Application Default Credentials, or the local Firestore emulator
// (FIRESTORE_EMULATOR_HOST).
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sql = readFileSync(join(root, "seed", "0007_seed.sql"), "utf8");
const dryRun = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// SQL VALUES scanner: returns arrays of parsed tuples for a region.
// Handles single-quoted strings ('' and \' escapes), numbers, booleans, NULL.
// ---------------------------------------------------------------------------
function scanTuples(region) {
  const rows = [];
  let i = region.indexOf("values");
  if (i === -1) i = 0;
  const n = region.length;
  while (i < n) {
    if (region[i] !== "(") {
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    const row = [];
    let buf = "";
    let isString = false;
    let bufIsString = false;
    for (; j < n && depth > 0; j++) {
      const c = region[j];
      if (isString) {
        if (c === "'" && region[j + 1] === "'") { buf += "'"; j++; continue; }
        if (c === "\\" && region[j + 1] === "'") { buf += "'"; j++; continue; }
        if (c === "'") { isString = false; continue; }
        buf += c;
        continue;
      }
      if (c === "'") { isString = true; bufIsString = true; continue; }
      if (c === "(") depth++;
      if (c === ")") {
        depth--;
        if (depth === 0) {
          row.push(parseScalar(buf.trim(), bufIsString));
          buf = ""; bufIsString = false;
          break;
        }
      }
      if (c === "," && depth === 1) {
        row.push(parseScalar(buf.trim(), bufIsString));
        buf = ""; bufIsString = false;
        continue;
      }
      buf += c;
    }
    rows.push(row);
    i = j + 1;
  }
  return rows;
}

function parseScalar(raw, wasString) {
  if (wasString) return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "") return null;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return parseFloat(raw);
  return raw;
}

function sectionRows(startMarker, endMarker = "\non conflict") {
  const start = sql.indexOf(startMarker);
  if (start === -1) throw new Error(`section not found: ${startMarker}`);
  const end = sql.indexOf(endMarker, start);
  return scanTuples(sql.slice(start, end === -1 ? undefined : end));
}

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// ---------------------------------------------------------------------------
// Parse every section
// ---------------------------------------------------------------------------
const countries = sectionRows("insert into public.countries");
const adminPermissions = sectionRows("insert into public.admin_permissions");
const adminRoles = sectionRows("insert into public.admin_roles");
const rolePermLinks = sectionRows("insert into public.admin_role_permissions", ") as v(role_name, perm_code)");
const scamCategories = sectionRows("insert into public.scam_categories");
const scamArticles = sectionRows("insert into public.scam_articles");
const reportingResources = sectionRows("insert into public.reporting_resources");
const documentChunks = sectionRows("insert into public.document_chunks");
const courses = sectionRows("insert into public.courses");
const modules = sectionRows("insert into public.course_modules", ") as v(course_slug, title, description, sort)");
const lessons = sectionRows("insert into public.lessons", ") as v(course_slug, module_title, title, body, sort)");
const questionsRaw = sectionRows("insert into public.quiz_questions", ") as v(module_title, question, explanation, sort)");
const optionsRaw = sectionRows("insert into public.quiz_options", ") as v(question_text, option_text, is_correct, sort)");

// Drop scanner artifacts: rows must have the expected width.
const clean = (rows, width) => rows.filter((r) => r.length === width);

// ---------------------------------------------------------------------------
// Build Firestore documents
// ---------------------------------------------------------------------------
const now = FieldValue.serverTimestamp();
const data = {
  countries: {}, admin_permissions: {}, admin_roles: {}, admin_role_permissions: {},
  scam_categories: {}, scam_articles: {}, reporting_resources: {}, document_chunks: {},
  courses: {}, course_modules: {}, lessons: {}, quizzes: {}, quiz_questions: {}, quiz_answers: {},
};

for (const [id, name, consentRequired, minAge, note] of clean(countries, 5)) {
  data.countries[id] = { id, name, consent_required: consentRequired ?? true, consent_min_age: minAge ?? 13, reporting_note: note ?? "" };
}
for (const [code, description] of clean(adminPermissions, 2)) {
  data.admin_permissions[code] = { code, description, created_at: now };
}
for (const [name, description] of clean(adminRoles, 2)) {
  data.admin_roles[name] = { name, description, created_at: now };
}
for (const [roleName, permCode] of clean(rolePermLinks, 2)) {
  if (!data.admin_roles[roleName] || !data.admin_permissions[permCode]) continue;
  data.admin_role_permissions[`${roleName}__${permCode}`] = { role_id: roleName, permission_id: permCode };
}

const categoryIds = {};
for (const [slug, name, description, icon, sortOrder] of clean(scamCategories, 5)) {
  categoryIds[slug] = slug;
  data.scam_categories[slug] = { slug, name, description: description ?? "", icon: icon ?? "shield", sort_order: sortOrder ?? 0, status: "active", created_at: now, updated_at: now };
}

for (const [categorySlug, title, slug, description, warningSigns, prevention, responseSteps, reportingGuidance, sourceName, sourceUrl, country, trustLevel] of clean(scamArticles, 12)) {
  data.scam_articles[slug] = {
    category_id: categoryIds[categorySlug] ?? "",
    title, slug,
    description: description ?? "", warning_signs: warningSigns ?? "", prevention: prevention ?? "",
    response_steps: responseSteps ?? "", reporting_guidance: reportingGuidance ?? "",
    source_name: sourceName ?? "", source_url: sourceUrl ?? "",
    country: country ?? "", trust_level: trustLevel ?? "trusted_internal",
    last_verified: now, status: "active", created_at: now, updated_at: now,
  };
}

for (const [countryId, organization, category, officialUrl, phone, description] of clean(reportingResources, 8)) {
  const id = `${countryId}-${slugify(organization)}`;
  data.reporting_resources[id] = {
    country_id: countryId, organization, category: category ?? "scam",
    official_url: officialUrl, phone: phone ?? "", description: description ?? "",
    last_verified: now, status: "active", created_at: now, updated_at: now,
  };
}

for (const [title, content, sourceType, trustLevel] of clean(documentChunks, 4)) {
  data.document_chunks[slugify(title)] = { title, content, source_type: sourceType ?? "knowledge", trust_level: trustLevel ?? "trusted_internal", language: "en", created_at: now };
}

const courseIds = {};
for (const [slug, title, description, level, duration, icon, sortOrder] of clean(courses, 7)) {
  courseIds[slug] = slug;
  data.courses[slug] = { slug, title, description: description ?? "", level: level ?? "beginner", duration_minutes: duration ?? 30, icon: icon ?? "book", status: "published", sort_order: sortOrder ?? 0, created_at: now, updated_at: now };
}

const moduleIds = {}; // `${courseSlug}__${moduleTitle}` -> doc id
for (const [courseSlug, title, description, sortOrder] of clean(modules, 4)) {
  const id = `${courseIds[courseSlug]}-${slugify(title)}`;
  moduleIds[`${courseSlug}__${title}`] = id;
  data.course_modules[id] = { course_id: courseIds[courseSlug], title, description: description ?? "", sort_order: sortOrder ?? 0, created_at: now, updated_at: now };
}

// SEED FIX (documented in README): in the original SQL, 41 of 42 lesson rows
// put the LESSON title in the module-title column, so the `join … on
// m.title = v.module_title` silently dropped them (only one lesson survived).
// The content pattern is: each module gets 2 consecutive lessons in course
// order — tuple[1] is the lesson title, tuple[2] the summary line. We rebuild
// that mapping so every lesson lands in its intended module.
const lessonsByCourse = {};
for (const row of clean(lessons, 5)) {
  (lessonsByCourse[row[0]] ??= []).push(row);
}
for (const [courseSlug, rows] of Object.entries(lessonsByCourse)) {
  const courseModuleIds = Object.entries(moduleIds)
    .filter(([key]) => key.startsWith(`${courseSlug}__`))
    .map(([, id]) => id);
  const moduleSort = (id) => data.course_modules[id].sort_order;
  const sortedModuleIds = courseModuleIds.sort((a, b) => moduleSort(a) - moduleSort(b));
  rows.forEach((row, index) => {
    const moduleIndex = Math.min(sortedModuleIds.length - 1, Math.floor(index / 2));
    const moduleId = sortedModuleIds[moduleIndex];
    const lessonTitle = row[1];
    const summary = row[2];
    const body = row[3];
    const sortInModule = (index % 2) + 1;
    const id = `${moduleId}-${slugify(lessonTitle)}`;
    data.lessons[id] = { module_id: moduleId, title: lessonTitle, summary, body, sort_order: sortInModule, created_at: now, updated_at: now };
  });
}

const quizIds = {}; // `${courseSlug}__${moduleTitle}` -> quiz doc id
for (const [key, moduleId] of Object.entries(moduleIds)) {
  const id = `${moduleId}-quiz`;
  quizIds[key] = id;
  data.quizzes[id] = { module_id: moduleId, title: `Quiz: ${key.split("__")[1]}`, pass_percent: 60, max_attempts: 0, sort_order: 1, created_at: now, updated_at: now };
}

const questionIds = {}; // question text -> doc id
for (const [moduleTitle, question, explanation, sortOrder] of clean(questionsRaw, 4)) {
  const quizKey = Object.keys(quizIds).find((k) => k.endsWith(`__${moduleTitle}`));
  if (!quizKey) throw new Error(`question references unknown module: ${moduleTitle}`);
  const quizId = quizIds[quizKey];
  const id = `${quizId}-q${sortOrder}`;
  questionIds[question] = id;
  data.quiz_questions[id] = { quiz_id: quizId, question, explanation: explanation ?? "", sort_order: sortOrder, options: [], created_at: now, updated_at: now };
}

const optionsByQuestion = {};
for (const [questionText, optionText, isCorrect, sortOrder] of clean(optionsRaw, 4)) {
  const questionId = questionIds[questionText];
  if (!questionId) throw new Error(`option references unknown question: ${questionText.slice(0, 50)}`);
  const optionId = `${questionId}-o${sortOrder}`;
  (optionsByQuestion[questionId] ??= []).push({ id: optionId, option_text: optionText, sort_order: sortOrder });
  if (isCorrect) {
    data.quiz_answers[questionId] = { question_id: questionId, correct_option_id: optionId, explanation: data.quiz_questions[questionId].explanation, created_at: now };
  }
}
for (const [questionId, options] of Object.entries(optionsByQuestion)) {
  data.quiz_questions[questionId].options = options.sort((a, b) => a.sort_order - b.sort_order);
}

// ---------------------------------------------------------------------------
// Report / write
// ---------------------------------------------------------------------------
const summary = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Object.keys(v).length]));
console.log("Seed summary:", JSON.stringify(summary, null, 2));

const missingAnswers = Object.keys(data.quiz_questions).filter((q) => !data.quiz_answers[q]);
if (missingAnswers.length) {
  console.warn(`WARNING: ${missingAnswers.length} questions have no correct answer marked:`, missingAnswers.slice(0, 3));
}

if (dryRun) {
  console.log("Dry run — nothing written.");
} else {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.FIREBASE_PROJECT_ID ?? "demo-matrix-ai";
  const serviceEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const serviceKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const credential = serviceEmail && serviceKey ? cert({ projectId, clientEmail: serviceEmail, privateKey: serviceKey }) : undefined;
  initializeApp({ projectId, credential });
  const db = getFirestore();
  let written = 0;
  await db.runTransaction(async (tx) => {
    for (const [collection, docs] of Object.entries(data)) {
      for (const [id, doc] of Object.entries(docs)) {
        tx.set(db.collection(collection).doc(id), doc, { merge: true });
        written++;
      }
    }
  });
  console.log(`✅ Seeded ${written} documents into project "${projectId}".`);
}
