// =============================================================================
// QORVYNA documentation content — the complete platform guide (spec §20–§24).
// Structured blocks rendered by the docs system (no markdown pipeline needed).
// =============================================================================

export type DocBlock =
  | { t: "p"; text: string }
  | { t: "h2"; text: string }
  | { t: "h3"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "callout"; tone: "info" | "warn" | "success"; text: string }
  | { t: "code"; lang: string; code: string };

export type DocSection = {
  slug: string;
  title: string;
  blocks: DocBlock[];
};

export const DOC_SECTIONS: DocSection[] = [
  {
    slug: "introduction",
    title: "Introduction",
    blocks: [
      { t: "p", text: "QORVYNA is a technology platform built around one assistant, QORVYNA AI. It answers questions, helps you learn and write, and — in Agent mode — builds, checks and publishes real projects. Connected devices, automation, hosting and the cyber-safety tools sit in the same workspace. It is operated by the THAMJJ13.TOP White Hat Team." },
      { t: "callout", tone: "info", text: "QORVYNA is the new name of the platform that used to be called MATRIX. Your account, chats, projects, devices and certificates are unchanged." },
      { t: "h2", text: "What QORVYNA does" },
      { t: "ul", items: [
        "AI: writing, explanations, study, planning, research and coding help, in English, বাংলা and Banglish, with voice input and file and image attachments.",
        "Agents: Agent mode plans a project, writes the files, validates and builds them, and publishes when you ask — and tells you exactly how it ended.",
        "IoT: pair and control ESP32 boards and companion phone, watch and desktop apps.",
        "Automation: tasks that run on a schedule.",
        "Cloud: hosting for what you build, with versions and rollback.",
        "Developers: a file workspace, ZIP export and review-before-push GitHub commits.",
        "Safety: screenshot scanner, a verified scam library, reporting help, courses, quizzes and certificates.",
      ]},
      { t: "callout", tone: "info", text: "Robotics is part of where QORVYNA is going. It is planned and not available yet." },
      { t: "h2", text: "Who it is for" },
      { t: "p", text: "QORVYNA is designed for users aged 11 to 17. Registration enforces this age range server-side, and age verification is reviewed by the security team. In some countries, guardian consent is required and collected during onboarding." },
      { t: "callout", tone: "info", text: "QORVYNA helps broadly with digital life: computers, phones, apps, the internet, IT, coding and AI, alongside privacy, scam and cybersecurity guidance. It understands English, বাংলা and Banglish." },
      { t: "h2", text: "How privacy works" },
      { t: "p", text: "Personal records are owner-scoped in Firebase and every write goes through authenticated server routes. Personal information and secrets are redacted before content is sent to an AI provider. GitHub tokens are AES-256-GCM encrypted at rest and are never sent to an AI provider or the browser." },
    ],
  },
  {
    slug: "getting-started",
    title: "Getting Started",
    blocks: [
      { t: "p", text: "Creating a QORVYNA account takes a few minutes. You'll need a valid email address and your date of birth." },
      { t: "h2", text: "Create your account" },
      { t: "ol", items: [
        "Open QORVYNA and choose Create account.",
        "Enter your name, email and a strong password (at least 8 characters — a passphrase is better).",
        "Enter your date of birth. QORVYNA is for ages 11–17; this is validated again server-side.",
        "Upload an age-verification document (a birth certificate photo or accepted ID). It goes to a private bucket, is reviewed by a human, and is never sent to the AI.",
        "Verify your email with the link we send you.",
        "Complete your profile (school, grade, country) and you're in.",
      ]},
      { t: "h2", text: "Guardian consent" },
      { t: "p", text: "Depending on your country and age, a parent or guardian may need to provide consent. The onboarding flow walks you through it; the security team reviews submissions and you'll get a notification when it's approved." },
      { t: "callout", tone: "success", text: "While verification is pending you can still explore the Scam Library and Documentation." },
      { t: "h2", text: "Sign in" },
      { t: "p", text: "Use your email and password, or continue with Google. If you've enabled two-factor authentication, you'll enter a 6-digit code from your authenticator app after your password." },
    ],
  },
  {
    slug: "account",
    title: "Account",
    blocks: [
      { t: "p", text: "Your account is made of two parts: your sign-in identity (email/password/OAuth, managed by Firebase Auth) and your QORVYNA profile (name, school, country, and settings)." },
      { t: "h2", text: "What you can change" },
      { t: "ul", items: [
        "Full name, phone, school and grade — in Settings → Account.",
        "Password and two-factor authentication — in Settings → Security.",
        "Notification preferences — in Settings → Notifications.",
        "Appearance (dark/light/system) — in Settings → Appearance.",
        "GitHub repository connection — in Settings → Integrations.",
      ]},
      { t: "h2", text: "What you cannot change directly" },
      { t: "ul", items: [
        "Your email and date of birth are locked for safety. Email changes require verification; date of birth and age verification can only be changed through the security team.",
        "Your age verification status is set server-side after document review — never by the frontend.",
      ]},
      { t: "h2", text: "Delete your account" },
      { t: "p", text: "Settings → Privacy → Delete account. You'll be asked to re-authenticate, then a server-side workflow removes your conversations, memories, progress, certificates, reports and files. This cannot be undone." },
    ],
  },
  {
    slug: "ai-assistant",
    title: "AI Assistant",
    blocks: [
      { t: "p", text: "QORVYNA Chat is a broadly useful assistant for writing, learning, planning, research, technology and safe digital life. Every request goes through a secure server-side gateway using the OpenAI-compatible endpoint, model and API key configured by the admin, with environment fallbacks when that is not available." },
      { t: "h2", text: "What it can do" },
      { t: "ul", items: [
        "Explain difficult topics, improve writing, summarise material and build practical plans.",
        "Help with computers, phones, apps, AI, troubleshooting and source code.",
        "Read attached text and common source-code files; inspect images without exposing private image bytes to the coding model.",
        "Explain phishing, scams, privacy, malware and device security with calm defensive guidance.",
        "Reply naturally in English, বাংলা or Banglish.",
      ]},
      { t: "h2", text: "Who you are talking to" },
      { t: "p", text: "The assistant is QORVYNA AI, in every mode and every language. Ask it who it is and it tells you. Ask which AI model or company's technology is behind it and it answers truthfully and specifically, from the configuration your request actually used — it does not dodge the question and it does not guess. By default that model is GPT OSS 120B, an open-weight model published by OpenAI and served by Groq; QORVYNA is the product you use, not the maker of the model." },
      { t: "h2", text: "What it won't do" },
      { t: "ul", items: [
        "Claim it opened, ran, tested, previewed, committed or deployed something when no real tool result exists.",
        "Help with harmful activity: credential theft, malware creation, account takeover, DDoS, phishing infrastructure or detection evasion.",
        "Invent reporting websites, phone numbers, citations, commits, files or test results.",
        "Ask for or repeat passwords, tokens, codes, private keys, ID numbers or payment details.",
      ]},
      { t: "callout", tone: "warn", text: "Even when a request sounds harmless ('just for a game'), QORVYNA refuses harmful cyber requests and redirects to defensive alternatives." },
      { t: "h2", text: "How your messages are protected" },
      { t: "p", text: "Before your message reaches the model, a PII redaction layer removes emails, phone numbers, one-time codes, passwords, card numbers, addresses and ID-like data. If the request is off-topic or harmful, the model is never contacted at all." },
    ],
  },
  {
    slug: "chat",
    title: "Chat",
    blocks: [
      { t: "p", text: "The chat is the heart of QORVYNA. Open /chat to start a new conversation or pick one from your history in the sidebar." },
      { t: "h2", text: "Conversation features" },
      { t: "ul", items: [
        "Streaming responses — replies appear progressively as they're generated.",
        "Stop generating — halt a response mid-stream.",
        "Retry and Regenerate — recover from errors or get a fresh answer.",
        "Copy button on every assistant message.",
        "Markdown, lists and code blocks rendered safely.",
        "Attach plain-text documents and common source-code files (the model is text-only, so images cannot be read). If you refer to missing material, QORVYNA asks you to provide it instead of guessing.",
        "Switch between General Chat and Agent; existing conversations keep their original mode.",
        "Replies come from GPT OSS 120B by default. You can switch on additional models from the composer; when several are on, each takes a different part of the request and you get one combined answer.",
        "Rename, archive, export (JSON) and delete conversations.",
        "Search your conversations from the sidebar.",
      ]},
      { t: "h2", text: "History" },
      { t: "p", text: "Conversations are grouped by Today, Yesterday, Previous 7 days and Older. Each has a context menu with Rename, Archive and Delete. Archive hides it from the sidebar without deleting it." },
      { t: "h2", text: "How context works" },
      { t: "p", text: "Long conversations are summarised, and the summary plus recent messages (not the whole transcript) are sent to the model. Safe memory facts about you (for example \"user is a beginner\") may be included. You can view and delete memories in Settings → Privacy." },
    ],
  },
  {
    slug: "agent-mode",
    title: "Agent Mode",
    blocks: [
      { t: "p", text: "Chat answers in words. Agent mode does the work: it changes real project files, checks them, builds them and — when you ask — publishes them. The two are kept apart on purpose, so nothing is changed or published by accident and nothing is described as done when it was not." },
      { t: "h2", text: "Asking for real work" },
      { t: "ol", items: [
        "Choose Agent in the Chat / Agent switcher and say what you want: \"Build a portfolio site\", \"Update my project\", \"Change the design\", \"Add this feature\", \"Deploy it\". English, বাংলা and Banglish all work.",
        "The Agent plans, writes the files, validates and builds them, and shows each step as it really happens. You can stop it at any time.",
        "Open the workspace to see every file. A project that can be previewed opens in the live preview.",
        "If you asked it to publish, the public address appears only after the host reports the site live.",
      ]},
      { t: "h2", text: "If you ask in Chat instead" },
      { t: "p", text: "Ask for the same kind of work in ordinary chat and nothing is sent to the AI. A card appears — Awaiting approval — with two choices: Run with Agent, which carries the request out for real, or Answer in chat instead, which gives you advice or code and changes nothing. If a chat reply ever sounds as if it changed your project, it is marked Text only, with a button to run the request properly." },
      { t: "h2", text: "How every task ends" },
      { t: "ul", items: [
        "Completed — the work was built and validated. \"Published\" is said only when there is a live address.",
        "Failed — something broke. The reason is shown and you can retry; files already saved stay in the project.",
        "Blocked — it cannot run until something else changes, for example no project was chosen or publishing is not set up. The obstacle and the next step are named.",
        "Awaiting approval — it is waiting for your go-ahead.",
      ]},
      { t: "callout", tone: "info", text: "These states come from the record of the run, not from what the AI says about itself. Open Deployment details on any run to see its steps, changed files, checks and logs." },
      { t: "h2", text: "GitHub connection and push" },
      { t: "ol", items: [
        "Open the GitHub tab and choose Continue with GitHub.",
        "Review the generated files, repository, branch and commit message.",
        "Tick the approval checkbox and confirm the push.",
        "QORVYNA creates one atomic commit. It never pushes automatically, and General Chat has no push controls.",
      ]},
      { t: "callout", tone: "info", text: "The GitHub OAuth token is encrypted on the server and never included in an AI prompt. You can disconnect it from Settings → Integrations at any time." },
      { t: "h2", text: "Live Preview limits" },
      { t: "p", text: "Live Preview safely renders generated static HTML, CSS and JavaScript in a sandboxed frame. React, Next.js and other framework projects still need their real build/runtime; QORVYNA shows the source files instead of faking a framework preview." },
    ],
  },
  {
    slug: "temporary-chat",
    title: "Temporary Chat",
    blocks: [
      { t: "p", text: "Temporary Chat is for questions you don't want saved. Open it from the sidebar (or the 🕒 icon on mobile)." },
      { t: "h2", text: "What temporary means" },
      { t: "ul", items: [
        "Temporary conversations never appear in your normal history or chat search.",
        "They never enter your long-term memory.",
        "They never create permanent summaries.",
        "Their content is hard-deleted after 24 hours.",
        "They are excluded from data exports of permanent conversations.",
      ]},
      { t: "callout", tone: "info", text: "The header always shows: Temporary Chat — This conversation will not be saved to your account or memory." },
      { t: "h2", text: "When to use it" },
      { t: "p", text: "Use temporary chat for hypothetical questions, testing, or anything you'd rather not keep. Use normal chat when you want the conversation saved and searchable later." },
    ],
  },
  {
    slug: "screenshot-scanner",
    title: "Screenshot Scanner",
    blocks: [
      { t: "p", text: "Screenshot analysis is currently unavailable: QORVYNA's models are text models that cannot read images. To check a suspicious SMS, email or payment request, copy its text and paste it into Chat." },
      { t: "p", text: "The steps below describe the scanner as it works when image analysis is available." },
      { t: "h2", text: "How to use it" },
      { t: "ol", items: [
        "Open /scanner.",
        "Drag & drop a screenshot, click to choose a file, or paste an image.",
        "QORVYNA validates the file (type, size, dimensions) and stores it in a private bucket.",
        "The AI analyses it and returns a structured result.",
      ]},
      { t: "h2", text: "What the result includes" },
      { t: "ul", items: [
        "Risk level — low, medium, high or critical.",
        "Confidence — how sure the model is (never 100%).",
        "What we found — suspicious indicators.",
        "Recommended actions and what NOT to do.",
        "Steps if you already clicked or shared information.",
        "Reporting options from verified resources only.",
      ]},
      { t: "callout", tone: "warn", text: "QORVYNA never claims 100% certainty from a screenshot alone. When in doubt, involve a trusted adult." },
      { t: "h2", text: "File rules" },
      { t: "p", text: "PNG, JPEG and WebP, up to 8 MB. Executables and mismatched file types are rejected. Files are stored in a private bucket — only you can access them." },
    ],
  },
  {
    slug: "scam-detection",
    title: "Scam Detection",
    blocks: [
      { t: "p", text: "QORVYNA helps you recognise scams before they hurt you. The Scam Library ( /scams ) documents the patterns scammers use, with verified sources." },
      { t: "h2", text: "Categories" },
      { t: "ul", items: [
        "Phishing — fake messages that steal passwords and codes.",
        "OTP scams — tricking you into sharing one-time codes.",
        "Fake jobs and tasks — 'easy money' that costs you.",
        "Investment and crypto scams — guaranteed profits that don't exist.",
        "Fake tech support — 'your device is infected' calls.",
        "Marketplace scams, social media scams, QR scams, malware scams, impersonation and giveaway scams.",
      ]},
      { t: "h2", text: "Risk levels" },
      { t: "p", text: "Analyses return a risk level: low (no clear indicators), medium (some suspicious patterns), high (strong scam indicators) or critical (immediate action recommended). Confidence expresses how strong the evidence is." },
      { t: "h2", text: "Reporting a scam" },
      { t: "p", text: "Use /report to file a private report, and follow the verified official resources for your country for formal reporting. QORVYNA never invents reporting websites." },
    ],
  },
  {
    slug: "reporting",
    title: "Reporting",
    blocks: [
      { t: "p", text: "When something goes wrong, reporting helps protect you and everyone else. QORVYNA separates three kinds of reporting:" },
      { t: "h2", text: "Platform report" },
      { t: "p", text: "The /report form files a private report to the QORVYNA support team. It includes what happened, what was affected, and whether you have evidence. Reports are protected by Row Level Security — only you and the support team can see yours." },
      { t: "h2", text: "Official reporting" },
      { t: "p", text: "For formal action, QORVYNA points you to verified official organisations — for example the FTC (US), Action Fraud (UK), Scamwatch (AU), the Canadian Anti-Fraud Centre, or the Digital Security Agency (BD). These are stored in the reporting resources database with verification timestamps." },
      { t: "callout", tone: "info", text: "QORVYNA never invents reporting URLs or phone numbers. Only verified resources are shown." },
      { t: "h2", text: "Platform reporting" },
      { t: "p", text: "Most apps (WhatsApp, Instagram, email providers) have built-in report buttons. Report the scam account there too — platforms can take it down." },
    ],
  },
  {
    slug: "courses",
    title: "Courses",
    blocks: [
      { t: "p", text: "QORVYNA includes structured courses that turn cyber safety into a curriculum. Each course has modules, lessons and quizzes." },
      { t: "h2", text: "Available courses" },
      { t: "ul", items: [
        "Cyber Safety Basics",
        "Phishing & Scam Detection",
        "Password & MFA Security",
        "Social Media Security",
        "Privacy & Digital Footprint",
        "Device Security",
        "Cybersecurity Fundamentals",
      ]},
      { t: "h2", text: "Progress" },
      { t: "p", text: "Open a course to see its modules and lessons. Mark lessons complete as you go — progress is stored per lesson and shown as a percentage. Quizzes are scored server-side in the database, so results can't be faked." },
      { t: "h2", text: "Completing a course" },
      { t: "p", text: "Finish every lesson and pass every quiz (60% or higher) to become eligible for a certificate." },
    ],
  },
  {
    slug: "certificates",
    title: "Certificates",
    blocks: [
      { t: "p", text: "Completing a course earns you a verifiable QORVYNA certificate issued by THAMJJ13.TOP White Hat Team." },
      { t: "h2", text: "How certificates work" },
      { t: "ol", items: [
        "Complete all lessons in a course.",
        "Pass all quizzes with the required score.",
        "QORVYNA issues a certificate with a unique ID (for example MATRIX-2026-AB12CD34).",
        "Find it on /certificates with its issue date and verification status.",
      ]},
      { t: "h2", text: "Public verification" },
      { t: "p", text: "Anyone can verify a certificate at /certificate/verify/:id. The public verification page shows only:" },
      { t: "ul", items: [
        "Certificate ID",
        "Course",
        "Display name",
        "Completion date",
        "Issued by (QORVYNA — THAMJJ13.TOP White Hat Team)",
        "Verification status",
      ]},
      { t: "callout", tone: "success", text: "Public verification never reveals email, phone, date of birth, address or school information." },
    ],
  },
  {
    slug: "security",
    title: "Security",
    blocks: [
      { t: "p", text: "The /security page gives you a live view of your account protection: your Cyber Safety Score, security events, active sessions and recommendations." },
      { t: "h2", text: "Cyber Safety Score" },
      { t: "p", text: "A 0–100 score computed server-side from real signals: email verification, age verification, two-factor authentication, completed lessons and certificates." },
      { t: "h2", text: "Recommendations" },
      { t: "ul", items: [
        "Enable MFA — the single most effective protection.",
        "Use a strong passphrase and never reuse passwords.",
        "Complete the security courses.",
        "Review active sessions and revoke devices you don't recognise.",
        "Turn on security alerts in notifications.",
      ]},
      { t: "h2", text: "Security events" },
      { t: "p", text: "Logins, password changes, MFA changes and verification events appear here. Only safe metadata is logged — never secrets." },
    ],
  },
  {
    slug: "privacy",
    title: "Privacy",
    blocks: [
      { t: "p", text: "Privacy is the architecture of QORVYNA, not a feature. Operated by THAMJJ13.TOP White Hat Team for users aged 11–17." },
      { t: "h2", text: "What we store" },
      { t: "ul", items: [
        "Profile (name, date of birth for age verification, school, country).",
        "Conversations, memories, course progress, quiz results, certificates.",
        "Security events and notification preferences.",
        "Your scam reports (private to you and support).",
      ]},
      { t: "h2", text: "What we never store" },
      { t: "ul", items: [
        "Passwords, OTPs, or authentication tokens (they live only in Firebase Auth's hashed store).",
        "Raw identity document numbers — only a verification reference and outcome.",
        "Payment information.",
      ]},
      { t: "h2", text: "Row Level Security" },
      { t: "p", text: "Every user-owned table has PostgreSQL Row Level Security enabled. Queries from the app can only ever reach your own rows — not even a code bug can expose another user's data through the normal API." },
      { t: "h2", text: "PII redaction before AI" },
      { t: "p", text: "Before any message reaches the model, a redaction layer removes emails, phone numbers, codes, passwords, addresses and ID-like data. The model is also instructed never to ask for or repeat them." },
    ],
  },
  {
    slug: "data-memory",
    title: "Data & Memory",
    blocks: [
      { t: "p", text: "QORVYNA can remember safe context about you to make help more personal — for example, that you're a beginner in cybersecurity. Memory is optional and fully under your control." },
      { t: "h2", text: "What memory stores" },
      { t: "p", text: "Only safe, useful learning context. A database trigger blocks secret-like content (passwords, OTPs, ID numbers, card numbers) from ever being stored as a memory." },
      { t: "h2", text: "Your controls (Settings → Privacy)" },
      { t: "ul", items: [
        "View Memory — see every saved fact.",
        "Delete Memory — remove individual facts.",
        "Disable Memory — stop new memories from being saved.",
        "Clear All Memory — wipe everything at once.",
        "Disable Chat History — new chats behave like temporary chats.",
      ]},
      { t: "h2", text: "Export your data" },
      { t: "p", text: "Settings → Privacy → Export my data generates a JSON file of your profile, conversations, progress, certificates and settings. The download link expires after 7 days. Exports never include passwords, tokens or internal secrets." },
    ],
  },
  {
    slug: "faq",
    title: "FAQ",
    blocks: [
      { t: "h2", text: "Is QORVYNA the same as MATRIX?" },
      { t: "p", text: "Yes. QORVYNA is the new name of the platform that was called MATRIX. Nothing about your account changed: the same sign-in, chats, projects, devices and certificates. Certificates issued earlier stay valid." },
      { t: "h2", text: "Which AI model does QORVYNA use?" },
      { t: "p", text: "Ask the assistant — it will tell you what your conversation is running on. By default it is GPT OSS 120B, an open-weight model published by OpenAI and served by Groq. The AI model page shows which other models are available to your account and lets you switch them on." },
      { t: "h2", text: "Why did the chat ask me to run my request with the Agent?" },
      { t: "p", text: "Because you asked for something that changes a real project, and a chat reply can only describe that. Choose Run with Agent to have it done, or Answer in chat instead if you only wanted advice." },
      { t: "h2", text: "Is QORVYNA free?" },
      { t: "p", text: "Yes — QORVYNA is free for users aged 11–17." },
      { t: "h2", text: "Why do I need to verify my age?" },
      { t: "p", text: "QORVYNA is designed for teens. Age verification keeps the community age-appropriate and meets child-safety requirements. The document is stored privately and reviewed by a human; the number itself is never stored or sent to the AI." },
      { t: "h2", text: "Does QORVYNA see my passwords?" },
      { t: "p", text: "No. Passwords are stored only as hashes by Firebase Auth, and the PII redaction layer strips anything password-like before it could reach the AI." },
      { t: "h2", text: "What if the AI refuses my question?" },
      { t: "p", text: "QORVYNA answers harmless digital-life questions instead of blocking them. It only refuses clearly harmful operational cyber requests, and always suggests a defensive or legal alternative. You can ask naturally in English, বাংলা, or Banglish." },
      { t: "h2", text: "Can I delete everything?" },
      { t: "p", text: "Yes. Settings → Privacy → Delete account removes your profile, chats, memories, progress, certificates, reports and files after re-authentication." },
      { t: "h2", text: "Who is THAMJJ13.TOP?" },
      { t: "p", text: "THAMJJ13.TOP is the development company behind QORVYNA, and its White Hat Team operates the platform's security and safety operations." },
    ],
  },
  {
    slug: "safety",
    title: "Safety",
    blocks: [
      { t: "p", text: "QORVYNA is built to be a safe place — technically and emotionally. If something bad happened online, you are not in trouble and you are not alone." },
      { t: "h2", text: "I Need Help Now" },
      { t: "p", text: "The /emergency page gives immediate defensive steps for: a hacked account, a suspicious link you clicked, an OTP you shared, money lost, a compromised social account, suspicious software, online threats or blackmail, and exposed personal information." },
      { t: "h2", text: "Telling a trusted adult" },
      { t: "p", text: "For anything serious — especially threats, blackmail or money lost — tell a trusted adult immediately. QORVYNA can guide you, but adults and authorities can act." },
      { t: "h2", text: "The platform's rules" },
      { t: "ul", items: [
        "Defensive guidance only — no operational help for harmful activity.",
        "No judgment, no fear-based language — calm, clear steps.",
        "Prompt-injection attempts are defended: the assistant always stays QORVYNA.",
        "Sensitive data is redacted before AI, and refused topics never reach the model.",
      ]},
    ],
  },
];

export const DOC_INDEX = DOC_SECTIONS.map((s) => ({
  slug: s.slug,
  title: s.title,
  headings: s.blocks.filter((b): b is Extract<DocBlock, { t: "h2" | "h3" }> => b.t === "h2" || b.t === "h3").map((b) => b.text),
}));

export function getDocSection(slug: string): DocSection | undefined {
  return DOC_SECTIONS.find((s) => s.slug === slug);
}

export function docNav(slug: string): { prev: DocSection | null; next: DocSection | null } {
  const idx = DOC_SECTIONS.findIndex((s) => s.slug === slug);
  if (idx < 0) return { prev: null, next: null };
  return {
    prev: idx > 0 ? DOC_SECTIONS[idx - 1] : null,
    next: idx < DOC_SECTIONS.length - 1 ? DOC_SECTIONS[idx + 1] : null,
  };
}
