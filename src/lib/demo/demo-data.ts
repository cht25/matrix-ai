// =============================================================================
// DEMO MODE data (development/testing preview only — NEVER enabled in
// production). Activated exclusively by NEXT_PUBLIC_DEMO_MODE=true and clearly
// badged in the UI. No real data is stored and no AI calls are made.
// =============================================================================

export const DEMO_USER = {
  id: "demo-user-0000",
  email: "alex@example.com",
  fullName: "Alex Teen",
};

export const demoProfile = {
  id: DEMO_USER.id,
  full_name: "Alex Teen",
  email: "alex@example.com",
  date_of_birth: "2012-03-14",
  age_verified: true,
  age_verified_at: "2026-07-02T10:00:00Z",
  school_name: "Greenfield High",
  class_grade: "Grade 8",
  country: "US",
  phone: "",
  avatar_url: "",
  created_at: "2026-07-01T09:00:00Z",
};

export const demoGuardianConsent = {
  id: "demo-consent",
  user_id: DEMO_USER.id,
  status: "approved",
  consent_method: "guardian",
  guardian_name: "Sam Teen",
  consented_at: "2026-07-02T11:00:00Z",
};

export const demoSettings = {
  user_id: DEMO_USER.id,
  memory_enabled: true,
  chat_history_enabled: true,
  notifications_email: true,
  notifications_push: false,
  notifications_security_alerts: true,
};

export const demoMemories = [
  { id: "m1", user_id: DEMO_USER.id, memory: "User is a beginner in cybersecurity.", source: "ai", created_at: "2026-07-10T12:00:00Z" },
  { id: "m2", user_id: DEMO_USER.id, memory: "User is learning about phishing scams.", source: "ai", created_at: "2026-07-15T14:00:00Z" },
];

export const demoConversations = [
  {
    id: "demo-conv-1", user_id: DEMO_USER.id, title: "Is this email a scam?", is_temporary: false,
    summary: "Analyzed a suspicious email claiming a prize win.", archived_at: null, deleted_at: null,
    created_at: "2026-08-10T10:00:00Z", updated_at: "2026-08-10T10:12:00Z",
  },
  {
    id: "demo-conv-2", user_id: DEMO_USER.id, title: "How do I make a strong password?", is_temporary: false,
    summary: "Explained passphrases and password managers.", archived_at: null, deleted_at: null,
    created_at: "2026-08-12T16:00:00Z", updated_at: "2026-08-12T16:20:00Z",
  },
];

export const demoMessages: Record<string, { role: string; content: string; created_at: string }[]> = {
  "demo-conv-1": [
    { role: "user", content: "Is this email a scam? It says I won a prize and need to pay a fee.", created_at: "2026-08-10T10:00:00Z" },
    {
      role: "assistant",
      content: "**Risk: High**\n\n**What I noticed:** This is a classic prize/lottery scam pattern — you never entered a contest, and the \"winner\" must pay a fee.\n\n**Why it matters:** Real prizes never ask winners to pay. Scammers use the fee to take your money or card details.\n\n**What to do now:** Don't reply, don't pay, and don't click any links. Tell a trusted adult.\n\n**Reporting options:** You can report it to the FTC at reportfraud.ftc.gov.",
      created_at: "2026-08-10T10:00:30Z",
    },
  ],
  "demo-conv-2": [
    { role: "user", content: "How do I make a strong password?", created_at: "2026-08-12T16:00:00Z" },
    {
      role: "assistant",
      content: "**Simple explanation:** Use a passphrase — 3 or 4 random words joined together, at least 12 characters.\n\n**Example:** `purple-lantern-cloud-42`\n\n**Safe practice:** Use a different passphrase for every account, and let a password manager remember them.\n\n**Common mistake:** Reusing the same password everywhere — when one site leaks it, scammers try it on all your other accounts.\n\n**Quick quiz:** Which is stronger: `abc123` or `purple-lantern-cloud-42`?",
      created_at: "2026-08-12T16:00:40Z",
    },
  ],
};

export const demoCourses = [
  {
    id: "demo-course-1", slug: "cyber-safety-basics", title: "Cyber Safety Basics",
    description: "Learn the ground rules of staying safe online — accounts, messages, and everyday habits.",
    level: "beginner", duration_minutes: 40, icon: "shield", status: "published", sort_order: 1,
  },
  {
    id: "demo-course-2", slug: "phishing-scam-detection", title: "Phishing & Scam Detection",
    description: "Learn to recognise phishing, fake shops and scams before they hurt you.",
    level: "beginner", duration_minutes: 45, icon: "fish", status: "published", sort_order: 2,
  },
  {
    id: "demo-course-3", slug: "password-mfa-security", title: "Password & MFA Security",
    description: "Create strong passwords, use a password manager and turn on two-factor authentication.",
    level: "beginner", duration_minutes: 35, icon: "key", status: "published", sort_order: 3,
  },
];

export const demoModules = [
  { id: "demo-mod-1", course_id: "demo-course-1", title: "Your Online Accounts", description: "Why accounts matter and how they get taken over.", sort_order: 1 },
  { id: "demo-mod-2", course_id: "demo-course-1", title: "Safe Messaging Habits", description: "How to handle messages from people you do not know.", sort_order: 2 },
  { id: "demo-mod-3", course_id: "demo-course-1", title: "When Something Goes Wrong", description: "The calm, correct steps when something bad happens.", sort_order: 3 },
  { id: "demo-mod-4", course_id: "demo-course-2", title: "What Phishing Looks Like", description: "Anatomy of a phishing message.", sort_order: 1 },
  { id: "demo-mod-5", course_id: "demo-course-2", title: "How to Check and Report", description: "Verifying messages and reporting scams.", sort_order: 2 },
  { id: "demo-mod-6", course_id: "demo-course-3", title: "Passwords That Work", description: "Passphrases and password managers.", sort_order: 1 },
  { id: "demo-mod-7", course_id: "demo-course-3", title: "Two-Factor Authentication", description: "The second lock on your accounts.", sort_order: 2 },
];

export const demoLessons = [
  { id: "demo-lesson-1", module_id: "demo-mod-1", title: "Your email is the master key", summary: "Email is the master key to everything you do online.", body: "Your email address is usually the \"master key\": if someone takes over your email, they can reset passwords for your other accounts. That is why your email password should be the strongest one you have, and why you should never share it — even with your closest friends. Turn on two-factor authentication for email first, before any other account.", sort_order: 1 },
  { id: "demo-lesson-2", module_id: "demo-mod-1", title: "How accounts get taken over", summary: "Most takeovers are leaked passwords and shared codes.", body: "Most account takeovers happen because of leaked passwords (a website you used got hacked), reused passwords (same password everywhere), or shared one-time codes. A scammer does not need to \"hack\" you if you hand them the key.", sort_order: 2 },
  { id: "demo-lesson-3", module_id: "demo-mod-2", title: "The Pause Rule", summary: "Slowing down defeats most scams.", body: "Scams work by rushing you: \"act now\", \"your account will close\". The Pause Rule is simple: when a message makes you feel rushed, stop. Do not click, do not reply, do not send money or codes. Take ten minutes. Check with a trusted adult.", sort_order: 1 },
  { id: "demo-lesson-4", module_id: "demo-mod-3", title: "If something goes wrong", summary: "The right response fixes most of the damage.", body: "If you clicked a suspicious link, shared a code, or lost money: you are not in trouble. Act quickly and calmly: tell a trusted adult, change passwords from another device, log out of all sessions, keep screenshots.", sort_order: 1 },
  { id: "demo-lesson-5", module_id: "demo-mod-4", title: "Anatomy of a phishing message", summary: "Every phishing message has the same ingredients.", body: "Phishing messages usually contain: an urgent demand, a fake sender address, a link to a lookalike login page, and a request for a secret (password, code, card number). Real companies never ask for your password in a message.", sort_order: 1 },
  { id: "demo-lesson-6", module_id: "demo-mod-5", title: "Verifying a suspicious message", summary: "A checklist turns suspicion into certainty.", body: "When a message feels off: 1) Who really sent it? 2) Did I expect this? 3) Does it create urgency? 4) Does it ask for a secret or money? 5) Is the link address correct? Two or more ticked boxes → treat it as a scam.", sort_order: 1 },
  { id: "demo-lesson-7", module_id: "demo-mod-6", title: "Passphrases beat passwords", summary: "Length beats complexity.", body: "A passphrase is 3–4 random words put together, like \"purple-lantern-cloud-42\". It is long, easy to remember, and hard for computers to guess. Never reuse passwords.", sort_order: 1 },
  { id: "demo-lesson-8", module_id: "demo-mod-7", title: "What 2FA is and why it matters", summary: "A second lock stops stolen passwords from being enough.", body: "Two-factor authentication means logging in needs your password plus a second proof: a code from an authenticator app, a hardware key, or your fingerprint. If a scammer steals your password but not your phone, they still cannot get in.", sort_order: 1 },
];

export const demoQuizzes = [
  { id: "demo-quiz-1", module_id: "demo-mod-1", title: "Quiz: Your Online Accounts", pass_percent: 60, sort_order: 1 },
  { id: "demo-quiz-2", module_id: "demo-mod-7", title: "Quiz: Two-Factor Authentication", pass_percent: 60, sort_order: 1 },
];

export const demoQuizQuestions = [
  { id: "demo-q-1", quiz_id: "demo-quiz-1", question: "Which account should have your strongest password and 2FA first?", explanation: "Email is the master key — it can reset your other passwords.", sort_order: 1 },
  { id: "demo-q-2", quiz_id: "demo-quiz-1", question: "How do most accounts actually get taken over?", explanation: "Leaked, reused or shared passwords — not mysterious \"hacks\".", sort_order: 2 },
  { id: "demo-q-3", quiz_id: "demo-quiz-2", question: "2FA means…", explanation: "Password plus a second proof like an app code.", sort_order: 1 },
];

export const demoQuizOptions = [
  { id: "demo-o-1", question_id: "demo-q-1", option_text: "Email", sort_order: 1 },
  { id: "demo-o-2", question_id: "demo-q-1", option_text: "Gaming account", sort_order: 2 },
  { id: "demo-o-3", question_id: "demo-q-1", option_text: "A rarely used social account", sort_order: 3 },
  { id: "demo-o-4", question_id: "demo-q-2", option_text: "Mysterious super-hackers", sort_order: 1 },
  { id: "demo-o-5", question_id: "demo-q-2", option_text: "Leaked, reused or shared passwords", sort_order: 2 },
  { id: "demo-o-6", question_id: "demo-q-2", option_text: "Aliens", sort_order: 3 },
  { id: "demo-o-7", question_id: "demo-q-3", option_text: "Two friends authenticate you", sort_order: 1 },
  { id: "demo-o-8", question_id: "demo-q-3", option_text: "Password plus a second proof like an app code", sort_order: 2 },
  { id: "demo-o-9", question_id: "demo-q-3", option_text: "Two passwords for one account", sort_order: 3 },
];

export const demoCertificates = [
  {
    id: "demo-cert-1", user_id: DEMO_USER.id, course_id: "demo-course-1",
    certificate_id: "MATRIX-2026-DEMO0001", issued_at: "2026-08-01T09:00:00Z", verification_status: "valid",
  },
];

export const demoScamCategories = [
  { id: "demo-cat-1", slug: "phishing", name: "Phishing", description: "Fake messages that trick you into giving passwords, codes or money.", icon: "fish", sort_order: 1 },
  { id: "demo-cat-2", slug: "online-shopping", name: "Online Shopping", description: "Fake shops, fake sellers and goods that never arrive.", icon: "cart", sort_order: 2 },
  { id: "demo-cat-3", slug: "prize-lottery", name: "Prize & Lottery", description: "\"You won!\" messages that ask you to pay first.", icon: "gift", sort_order: 3 },
];

export const demoScamArticles = [
  {
    id: "demo-art-1", category_id: "demo-cat-1", title: "Spotting Phishing Messages", slug: "spotting-phishing-messages",
    description: "Phishing is when a scammer sends a fake message that looks like it is from a real company.",
    warning_signs: "Urgency, spelling mistakes, unknown links, asks for your password or one-time code.",
    prevention: "Never click links in unexpected messages. Type the website address yourself. Turn on 2FA.",
    response_steps: "Do not click or reply. If you clicked, change your password and tell a trusted adult.",
    reporting_guidance: "Report phishing to the official reporting organisation for your country.",
    source_name: "APWG & FTC guidance", source_url: "https://www.ftc.gov/", country: "US", last_verified: "2026-08-01", status: "active",
  },
  {
    id: "demo-art-2", category_id: "demo-cat-3", title: "Prize and Lottery Scams", slug: "prize-lottery-scams",
    description: "\"Congratulations, you won!\" messages ask you to pay a small fee to receive a prize that does not exist.",
    warning_signs: "You never entered, you must pay to receive the prize, gift cards requested.",
    prevention: "Real prizes are never given to people who did not enter, and winners never pay fees.",
    response_steps: "Do not send money or codes. Keep the message as evidence and tell a trusted adult.",
    reporting_guidance: "Report the message to the official reporting organisation.",
    source_name: "FTC guidance", source_url: "https://consumer.ftc.gov/", country: "US", last_verified: "2026-08-01", status: "active",
  },
];

export const demoSecurityEvents = [
  { id: "e1", user_id: DEMO_USER.id, event_type: "login", metadata: { source: "auth_webhook" }, created_at: "2026-08-18T08:00:00Z" },
  { id: "e2", user_id: DEMO_USER.id, event_type: "mfa_enabled", metadata: {}, created_at: "2026-07-20T12:00:00Z" },
  { id: "e3", user_id: DEMO_USER.id, event_type: "identity_verified", metadata: {}, created_at: "2026-07-02T10:00:00Z" },
  { id: "e4", user_id: DEMO_USER.id, event_type: "consent_approved", metadata: {}, created_at: "2026-07-02T11:00:00Z" },
];

export const demoAnalyses = [
  {
    id: "a1", user_id: DEMO_USER.id, analysis_type: "screenshot", input_reference: "demo",
    risk_level: "high", confidence: 0.87,
    findings: { reply: "**Risk: High** — This screenshot shows a fake login page. The address uses 'secure-log1n.xyz' instead of the real site." },
    recommendation: "Do not enter your password. Close the page and type the official website address yourself.",
    created_at: "2026-08-15T09:00:00Z",
  },
];

export const demoReports = [
  {
    id: "r1", user_id: DEMO_USER.id, category_id: "demo-cat-3", platform: "SMS",
    description: "Prize scam message asking for a fee.", money_lost: 0, account_compromised: false,
    personal_information_shared: false, evidence_available: true, country: "US", status: "submitted", created_at: "2026-08-14T10:00:00Z",
  },
];

export const demoProgress = [
  { id: "p1", user_id: DEMO_USER.id, lesson_id: "demo-lesson-1", status: "completed", progress: 100, completed_at: "2026-07-25T10:00:00Z" },
  { id: "p2", user_id: DEMO_USER.id, lesson_id: "demo-lesson-2", status: "completed", progress: 100, completed_at: "2026-07-26T10:00:00Z" },
  { id: "p3", user_id: DEMO_USER.id, lesson_id: "demo-lesson-3", status: "completed", progress: 100, completed_at: "2026-07-27T10:00:00Z" },
];

export const demoQuizAttempts = [
  { id: "qa1", user_id: DEMO_USER.id, quiz_id: "demo-quiz-1", score_percent: 100, passed: true, completed_at: "2026-07-28T10:00:00Z" },
];

export const demoNotifications = [
  { id: "n1", user_id: DEMO_USER.id, type: "certificate", title: "Certificate earned!", body: "You completed \"Cyber Safety Basics\" and earned a certificate.", link: "/certificate", read_at: null, created_at: "2026-08-01T09:00:00Z" },
  { id: "n2", user_id: DEMO_USER.id, type: "security", title: "New login", body: "Your account was signed in from a new session.", link: "/security", read_at: "2026-08-18T08:05:00Z", created_at: "2026-08-18T08:00:00Z" },
];
