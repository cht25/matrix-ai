// =============================================================================
// Demo client — a minimal Supabase-compatible surface used ONLY when
// NEXT_PUBLIC_DEMO_MODE=true. Clearly badged in the UI; never ships data.
// =============================================================================

import {
  DEMO_USER, demoProfile, demoGuardianConsent, demoSettings, demoMemories, demoConversations,
  demoMessages, demoCourses, demoCertificates, demoScamCategories, demoScamArticles,
  demoSecurityEvents, demoAnalyses, demoReports, demoProgress, demoQuizAttempts, demoNotifications,
  demoModules, demoLessons, demoQuizzes, demoQuizQuestions, demoQuizOptions,
} from "./demo-data";

type Row = Record<string, unknown>;

const TABLES: Record<string, Row[]> = {
  profiles: [demoProfile as unknown as Row],

  user_security_settings: [demoSettings as unknown as Row],
  user_memories: demoMemories as unknown as Row[],
  conversations: demoConversations as unknown as Row[],
  conversation_messages: [],
  scam_categories: demoScamCategories as unknown as Row[],
  scam_articles: demoScamArticles as unknown as Row[],
  courses: demoCourses as unknown as Row[],
  certificates: demoCertificates as unknown as Row[],
  security_events: demoSecurityEvents as unknown as Row[],
  security_analyses: demoAnalyses as unknown as Row[],
  scam_reports: demoReports as unknown as Row[],
  notifications: demoNotifications as unknown as Row[],
  quiz_attempts: demoQuizAttempts as unknown as Row[],
  course_progress: demoProgress as unknown as Row[],
  course_modules: demoModules as unknown as Row[],
  lessons: demoLessons as unknown as Row[],
  quizzes: demoQuizzes as unknown as Row[],
  quiz_questions: demoQuizQuestions as unknown as Row[],
  quiz_options_public: demoQuizOptions as unknown as Row[],
  admin_permissions: [
    { id: "ap1", code: "users.view" }, { id: "ap2", code: "reports.view" },
    { id: "ap3", code: "verification.review" }, { id: "ap4", code: "consent.review" },
    { id: "ap5", code: "ai.view" }, { id: "ap6", code: "audit.view" },
    { id: "ap7", code: "content.manage" }, { id: "ap8", code: "privacy.access" },
  ],
  identity_verifications: [
    { id: "iv1", user_id: "00000000-0000-0000-0000-000000000099", verification_type: "birth_certificate", verification_status: "pending_review", verification_reference: "demo-user/birth-certificate-1.jpg", created_at: "2026-08-17T09:00:00Z" },
  ],
  guardian_consents: [
    { id: "gc1", user_id: "00000000-0000-0000-0000-000000000098", status: "pending", consent_method: "guardian", guardian_name: "Jordan Smith", guardian_email: "jordan@example.com", created_at: "2026-08-16T10:00:00Z" },
    demoGuardianConsent as unknown as Row,
  ],
  ai_safety_events: [
    { id: 1, event_type: "off_topic", detail: "off-topic request refused", created_at: "2026-08-17T11:00:00Z" },
    { id: 2, event_type: "pii_detected", detail: "otp,password", created_at: "2026-08-17T12:00:00Z" },
    { id: 3, event_type: "harmful_request", detail: "ddos", created_at: "2026-08-17T13:00:00Z" },
  ],
  audit_logs: [
    { id: 1, actor_id: DEMO_USER.id, action: "identity_verification_approved", target_type: "identity_verification", target_id: "iv0", reason: "document matched", created_at: "2026-08-02T09:00:00Z" },
    { id: 2, actor_id: DEMO_USER.id, action: "scam_article_status_changed", target_type: "scam_articles", target_id: "demo-art-1", reason: "→ active", created_at: "2026-08-05T09:00:00Z" },
  ],
  admin_access_grants: [
    { id: "g1", requester_id: DEMO_USER.id, target_user_id: "00000000-0000-0000-0000-000000000099", scope: "conversations", reason: "support request investigation", status: "active", expires_at: "2026-08-25T09:00:00Z", created_at: "2026-08-18T09:00:00Z" },
  ],
  reporting_resources: [
    { id: "rr1", country_id: "US", organization: "FTC — ReportFraud.ftc.gov", category: "scam", official_url: "https://reportfraud.ftc.gov/", phone: "1-877-382-4357", description: "Official US federal consumer complaint channel for scams and fraud.", last_verified: "2026-08-01", status: "active" },
    { id: "rr2", country_id: "GB", organization: "Action Fraud", category: "scam", official_url: "https://www.actionfraud.police.uk/", phone: "0300 123 2040", description: "Official UK national reporting centre for fraud and cybercrime.", last_verified: "2026-08-01", status: "active" },
    { id: "rr3", country_id: "BD", organization: "Bangladesh Digital Security Agency (DSA)", category: "cybercrime", official_url: "https://dsa.gov.bd/", phone: "", description: "Official Bangladesh agency for digital security and cybercrime complaints.", last_verified: "2026-08-01", status: "active" },
  ],
  countries: [
    { id: "US", name: "United States", consent_required: true, consent_min_age: 13 },
    { id: "GB", name: "United Kingdom", consent_required: true, consent_min_age: 13 },
    { id: "BD", name: "Bangladesh", consent_required: true, consent_min_age: 13 },
  ],
};

function messagesFor(convId: string): Row[] {
  return (demoMessages[convId] ?? []).map((m, i) => ({ id: `dm-${i}`, conversation_id: convId, ...m }));
}

class DemoQuery {
  private rows: Row[];
  constructor(private table: string) {
    this.rows = TABLES[this.table] ?? [];
    if (this.table === "conversation_messages") {
      // resolved by conversation_id filter below
    }
  }

  select(_cols?: string) { return this; }
  update(_values: Record<string, unknown>) { return Promise.resolve({ data: null, error: null }); }
  insert(_values: unknown) { return Promise.resolve({ data: null, error: null }); }
  delete() { return Promise.resolve({ data: null, error: null }); }
  eq(col: string, value: unknown) {
    if (this.table === "conversation_messages" && col === "conversation_id") {
      this.rows = messagesFor(String(value));
      return this;
    }
    this.rows = this.rows.filter((r) => r[col] === value);
    return this;
  }
  neq(col: string, value: unknown) {
    this.rows = this.rows.filter((r) => r[col] !== value);
    return this;
  }
  is(col: string, value: unknown) {
    this.rows = this.rows.filter((r) => r[col] === value);
    return this;
  }
  not(col: string, _op: unknown, value: unknown) {
    this.rows = this.rows.filter((r) => r[col] !== value);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    const asc = opts?.ascending ?? true;
    this.rows = [...this.rows].sort((a, b) => {
      const av = String(a[col] ?? ""), bv = String(b[col] ?? "");
      return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return this;
  }
  limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
  maybeSingle() { return Promise.resolve({ data: this.rows[0] ?? null, error: null }); }
  single() {
    return Promise.resolve(this.rows.length === 1
      ? { data: this.rows[0], error: null }
      : { data: this.rows[0] ?? null, error: { message: "row not found" } });
  }
  then(resolve: (v: { data: Row[] | null; error: null }) => void) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}

const RPC_RESULTS: Record<string, unknown> = {
  security_score: 72,
  calculate_age: 14,
  verify_certificate_lookup: {
    valid: true,
    certificate_id: "MATRIX-2026-DEMO0001",
    course: "Cyber Safety Basics",
    display_name: "Alex Teen",
    issued_at: "2026-08-01T09:00:00Z",
    issued_by: "MATRIX AI — THAMJJ13.TOP White Hat Team",
    verification_status: "valid",
  },
  submit_quiz_attempt: {
    attempt_id: "demo-attempt",
    score_percent: 100,
    passed: true,
    correct: 3,
    total: 3,
    results: [
      { question_id: "demo-q-1", selected_option_id: "demo-o-1", correct_option_id: "demo-o-1", correct: true },
      { question_id: "demo-q-2", selected_option_id: "demo-o-5", correct_option_id: "demo-o-5", correct: true },
      { question_id: "demo-q-3", selected_option_id: "demo-o-8", correct_option_id: "demo-o-8", correct: true },
    ],
  },
  update_course_progress: { ok: true },
  issue_certificate: { certificate_id: "MATRIX-2026-DEMO0001", course: "Cyber Safety Basics" },
  admin_list_users: [
    { id: DEMO_USER.id, email: "alex@example.com", full_name: "Alex Teen", created_at: "2026-07-01T09:00:00Z", last_sign_in_at: "2026-08-18T08:00:00Z", age_verified: true, country: "US", consent_status: "approved", identity_status: "approved" },
    { id: "00000000-0000-0000-0000-000000000099", email: "maya@example.com", full_name: "Maya Khan", created_at: "2026-08-10T09:00:00Z", last_sign_in_at: "2026-08-17T10:00:00Z", age_verified: false, country: "BD", consent_status: "pending", identity_status: "pending_review" },
  ],
  request_admin_access: "demo-grant-123",
  admin_list_conversations: [
    { id: "demo-conv-1", title: "Is this email a scam?", created_at: "2026-08-10T10:00:00Z", updated_at: "2026-08-10T10:12:00Z", is_temporary: false },
  ],
  admin_view_conversation: [
    { role: "user", content: "Is this email a scam?" },
    { role: "assistant", content: "**Risk: High** — This is a classic prize scam pattern." },
  ],
};

export function createDemoClient() {
  return {
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: DEMO_USER.id,
            email: DEMO_USER.email,
            email_confirmed_at: "2026-07-01T09:00:00Z",
            user_metadata: { full_name: DEMO_USER.fullName },
          },
        },
        error: null,
      }),
      getSession: async () => ({ data: { session: { user: { id: DEMO_USER.id } } }, error: null }),
      signInWithPassword: async () => ({ data: { user: { id: DEMO_USER.id } }, error: null }),
      signUp: async () => ({ data: { user: { id: DEMO_USER.id } }, error: null }),
      signOut: async () => ({ error: null }),
      resetPasswordForEmail: async () => ({ error: null }),
      updateUser: async () => ({ data: { user: { id: DEMO_USER.id } }, error: null }),
      mfa: {
        enroll: async () => ({ data: null, error: { message: "MFA is disabled in demo mode" } }),
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => new DemoQuery(table) as unknown as ReturnType<typeof createDemoClient>["from"],
    rpc: async (fn: string, _args?: Record<string, unknown>) =>
      ({ data: RPC_RESULTS[fn] ?? null, error: null }),
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: "demo/upload.png" }, error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: "#demo" }, error: null }),
        remove: async () => ({ data: null, error: null }),
      }),
    },
    functions: {
      invoke: async (_name: string, _opts?: { body?: unknown }) => ({
        data: { error: "AI_GATEWAY_NOT_CONFIGURED" },
        error: null,
      }),
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
    authUrl: "",
  };
}

export type DemoClient = ReturnType<typeof createDemoClient>;
