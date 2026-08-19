// =============================================================================
// MATRIX documentation content — the complete platform guide (spec §20–§24).
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
  icon: string;
  blocks: DocBlock[];
};

export const DOC_SECTIONS: DocSection[] = [
  {
    slug: "introduction",
    title: "Introduction",
    icon: "🛡️",
    blocks: [
      { t: "p", text: "MATRIX is an all-in-one AI assistant and coding workspace operated by the THAMJJ13.TOP White Hat Team. It combines useful everyday chat, file-aware help, a dedicated software Agent, live preview, review-before-push GitHub integration, cyber-safety tools, guided learning and private account controls." },
      { t: "h2", text: "What MATRIX does" },
      { t: "ul", items: [
        "Helps with writing, explanations, study, planning, research, brainstorming, technology, digital life and coding.",
        "Automatically routes obvious coding requests to NVIDIA Nemotron 3 Ultra through OpenRouter.",
        "Builds reviewable project files in Agent mode, with a sandboxed static preview and explicit GitHub push.",
        "Accepts images, text documents and common source-code files as task context.",
        "Analyses suspicious screenshots and provides calm defensive guidance.",
        "Provides a verified scam library, reporting help, courses, quizzes and certificates.",
      ]},
      { t: "h2", text: "Who it is for" },
      { t: "p", text: "MATRIX is designed for users aged 11 to 17. Registration enforces this age range server-side, and age verification is reviewed by the security team. In some countries, guardian consent is required and collected during onboarding." },
      { t: "callout", tone: "info", text: "MATRIX helps broadly with digital life: computers, phones, apps, the internet, IT, coding and AI, alongside privacy, scam and cybersecurity guidance. It understands English, বাংলা and Banglish." },
      { t: "h2", text: "How privacy works" },
      { t: "p", text: "Personal records are owner-scoped in Firebase and every write goes through authenticated server routes. Personal information and secrets are redacted before content is sent to an AI provider. GitHub tokens are AES-256-GCM encrypted at rest and are never sent to Groq, OpenRouter or the browser." },
    ],
  },
  {
    slug: "getting-started",
    title: "Getting Started",
    icon: "🚀",
    blocks: [
      { t: "p", text: "Creating a MATRIX account takes a few minutes. You'll need a valid email address and your date of birth." },
      { t: "h2", text: "Create your account" },
      { t: "ol", items: [
        "Open MATRIX and choose Create account.",
        "Enter your name, email and a strong password (at least 8 characters — a passphrase is better).",
        "Enter your date of birth. MATRIX is for ages 11–17; this is validated again server-side.",
        "Upload an age-verification document (a birth certificate photo or accepted ID). It goes to a private bucket, is reviewed by a human, and is never sent to the AI.",
        "Verify your email with the link we send you.",
        "Complete your profile (school, grade, country) and you're in.",
      ]},
      { t: "h2", text: "Guardian consent" },
      { t: "p", text: "Depending on your country and age, a parent or guardian may need to provide consent. The onboarding flow walks you through it; the security team reviews submissions and you'll get a notification when it's approved." },
      { t: "callout", tone: "success", text: "While verification is pending you can still explore the Scam Library and Documentation." },
      { t: "h2", text: "Sign in" },
      { t: "p", text: "Use your email and password, or continue with Google or Facebook. If you've enabled two-factor authentication, you'll enter a 6-digit code from your authenticator app after your password." },
    ],
  },
  {
    slug: "account",
    title: "Account",
    icon: "👤",
    blocks: [
      { t: "p", text: "Your account is made of two parts: your sign-in identity (email/password/OAuth, managed by Firebase Auth) and your MATRIX profile (name, school, country, and settings)." },
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
    icon: "💬",
    blocks: [
      { t: "p", text: "MATRIX Chat is a broadly useful assistant for writing, learning, planning, research, technology and safe digital life. Every request goes through a secure server-side gateway. General tasks use Groq; coding is automatically detected and routed to NVIDIA Nemotron 3 Ultra through OpenRouter." },
      { t: "h2", text: "What it can do" },
      { t: "ul", items: [
        "Explain difficult topics, improve writing, summarise material and build practical plans.",
        "Help with computers, phones, apps, AI, troubleshooting and source code.",
        "Read attached text and common source-code files; inspect images without exposing private image bytes to the coding model.",
        "Explain phishing, scams, privacy, malware and device security with calm defensive guidance.",
        "Reply naturally in English, বাংলা or Banglish.",
      ]},
      { t: "h2", text: "What it won't do" },
      { t: "ul", items: [
        "Claim it opened, ran, tested, previewed, committed or deployed something when no real tool result exists.",
        "Help with harmful activity: credential theft, malware creation, account takeover, DDoS, phishing infrastructure or detection evasion.",
        "Invent reporting websites, phone numbers, citations, commits, files or test results.",
        "Ask for or repeat passwords, tokens, codes, private keys, ID numbers or payment details.",
      ]},
      { t: "callout", tone: "warn", text: "Even when a request sounds harmless ('just for a game'), MATRIX refuses harmful cyber requests and redirects to defensive alternatives." },
      { t: "h2", text: "How your messages are protected" },
      { t: "p", text: "Before your message reaches the model, a PII redaction layer removes emails, phone numbers, one-time codes, passwords, card numbers, addresses and ID-like data. If the request is off-topic or harmful, the model is never contacted at all." },
    ],
  },
  {
    slug: "chat",
    title: "Chat",
    icon: "🗨️",
    blocks: [
      { t: "p", text: "The chat is the heart of MATRIX. Open /chat to start a new conversation or pick one from your history in the sidebar." },
      { t: "h2", text: "Conversation features" },
      { t: "ul", items: [
        "Streaming responses — replies appear progressively as they're generated.",
        "Stop generating — halt a response mid-stream.",
        "Retry and Regenerate — recover from errors or get a fresh answer.",
        "Copy button on every assistant message.",
        "Markdown, lists and code blocks rendered safely.",
        "Attach images, plain-text documents and common source-code files. If you refer to missing material, MATRIX asks you to provide it instead of guessing.",
        "Switch between General Chat and Agent; existing conversations keep their original mode.",
        "See when a coding request was automatically handled by Nemotron 3 Ultra.",
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
    icon: "⌨️",
    blocks: [
      { t: "p", text: "Agent mode is the coding workspace. It uses NVIDIA Nemotron 3 Ultra through OpenRouter and is separate from General Chat so file generation, preview and GitHub actions are deliberate." },
      { t: "h2", text: "Build and review" },
      { t: "ol", items: [
        "Choose Agent in the sidebar or Chat/Agent switcher.",
        "Describe the product, bug or change. Attach relevant source files or an image reference when needed.",
        "Agent returns a human-readable approach plus complete generated files.",
        "Open Agent workspace to inspect every file. Static index.html projects can run in the sandboxed Live Preview.",
        "Verify the result yourself. MATRIX never claims tests or commands ran when no runtime was connected.",
      ]},
      { t: "h2", text: "GitHub connection and push" },
      { t: "ol", items: [
        "Open the GitHub tab and choose Continue with GitHub.",
        "Review the generated files, repository, branch and commit message.",
        "Tick the approval checkbox and confirm the push.",
        "MATRIX creates one atomic commit. It never pushes automatically, and General Chat has no push controls.",
      ]},
      { t: "callout", tone: "info", text: "The GitHub OAuth token is encrypted on the server and never included in an AI prompt. You can disconnect it from Settings → Integrations at any time." },
      { t: "h2", text: "Live Preview limits" },
      { t: "p", text: "Live Preview safely renders generated static HTML, CSS and JavaScript in a sandboxed frame. React, Next.js and other framework projects still need their real build/runtime; MATRIX shows the source files instead of faking a framework preview." },
    ],
  },
  {
    slug: "temporary-chat",
    title: "Temporary Chat",
    icon: "🕒",
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
    icon: "🔍",
    blocks: [
      { t: "p", text: "The scanner ( /scanner ) analyses screenshots of suspicious content: SMS messages, emails, websites, login pages, payment requests and social media posts." },
      { t: "h2", text: "How to use it" },
      { t: "ol", items: [
        "Open /scanner.",
        "Drag & drop a screenshot, click to choose a file, or paste an image.",
        "MATRIX validates the file (type, size, dimensions) and stores it in a private bucket.",
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
      { t: "callout", tone: "warn", text: "MATRIX never claims 100% certainty from a screenshot alone. When in doubt, involve a trusted adult." },
      { t: "h2", text: "File rules" },
      { t: "p", text: "PNG, JPEG and WebP, up to 8 MB. Executables and mismatched file types are rejected. Files are stored in a private bucket — only you can access them." },
    ],
  },
  {
    slug: "scam-detection",
    title: "Scam Detection",
    icon: "🎣",
    blocks: [
      { t: "p", text: "MATRIX helps you recognise scams before they hurt you. The Scam Library ( /scams ) documents the patterns scammers use, with verified sources." },
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
      { t: "p", text: "Use /report to file a private report, and follow the verified official resources for your country for formal reporting. MATRIX never invents reporting websites." },
    ],
  },
  {
    slug: "reporting",
    title: "Reporting",
    icon: "📢",
    blocks: [
      { t: "p", text: "When something goes wrong, reporting helps protect you and everyone else. MATRIX separates three kinds of reporting:" },
      { t: "h2", text: "Platform report" },
      { t: "p", text: "The /report form files a private report to the MATRIX support team. It includes what happened, what was affected, and whether you have evidence. Reports are protected by Row Level Security — only you and the support team can see yours." },
      { t: "h2", text: "Official reporting" },
      { t: "p", text: "For formal action, MATRIX points you to verified official organisations — for example the FTC (US), Action Fraud (UK), Scamwatch (AU), the Canadian Anti-Fraud Centre, or the Digital Security Agency (BD). These are stored in the reporting resources database with verification timestamps." },
      { t: "callout", tone: "info", text: "MATRIX never invents reporting URLs or phone numbers. Only verified resources are shown." },
      { t: "h2", text: "Platform reporting" },
      { t: "p", text: "Most apps (WhatsApp, Instagram, email providers) have built-in report buttons. Report the scam account there too — platforms can take it down." },
    ],
  },
  {
    slug: "courses",
    title: "Courses",
    icon: "🎓",
    blocks: [
      { t: "p", text: "MATRIX includes structured courses that turn cyber safety into a curriculum. Each course has modules, lessons and quizzes." },
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
    icon: "🏅",
    blocks: [
      { t: "p", text: "Completing a course earns you a verifiable MATRIX certificate issued by THAMJJ13.TOP White Hat Team." },
      { t: "h2", text: "How certificates work" },
      { t: "ol", items: [
        "Complete all lessons in a course.",
        "Pass all quizzes with the required score.",
        "MATRIX issues a certificate with a unique ID (for example MATRIX-2026-AB12CD34).",
        "Find it on /certificates with its issue date and verification status.",
      ]},
      { t: "h2", text: "Public verification" },
      { t: "p", text: "Anyone can verify a certificate at /certificate/verify/:id. The public verification page shows only:" },
      { t: "ul", items: [
        "Certificate ID",
        "Course",
        "Display name",
        "Completion date",
        "Issued by (MATRIX — THAMJJ13.TOP White Hat Team)",
        "Verification status",
      ]},
      { t: "callout", tone: "success", text: "Public verification never reveals email, phone, date of birth, address or school information." },
    ],
  },
  {
    slug: "security",
    title: "Security",
    icon: "🔐",
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
    icon: "🔒",
    blocks: [
      { t: "p", text: "Privacy is the architecture of MATRIX, not a feature. Operated by THAMJJ13.TOP White Hat Team for users aged 11–17." },
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
    icon: "🧠",
    blocks: [
      { t: "p", text: "MATRIX can remember safe context about you to make help more personal — for example, that you're a beginner in cybersecurity. Memory is optional and fully under your control." },
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
    icon: "❓",
    blocks: [
      { t: "h2", text: "Is MATRIX free?" },
      { t: "p", text: "Yes — MATRIX is free for users aged 11–17." },
      { t: "h2", text: "Why do I need to verify my age?" },
      { t: "p", text: "MATRIX is designed for teens. Age verification keeps the community age-appropriate and meets child-safety requirements. The document is stored privately and reviewed by a human; the number itself is never stored or sent to the AI." },
      { t: "h2", text: "Does MATRIX see my passwords?" },
      { t: "p", text: "No. Passwords are stored only as hashes by Firebase Auth, and the PII redaction layer strips anything password-like before it could reach the AI." },
      { t: "h2", text: "What if the AI refuses my question?" },
      { t: "p", text: "MATRIX answers harmless digital-life questions instead of blocking them. It only refuses clearly harmful operational cyber requests, and always suggests a defensive or legal alternative. You can ask naturally in English, বাংলা, or Banglish." },
      { t: "h2", text: "Can I delete everything?" },
      { t: "p", text: "Yes. Settings → Privacy → Delete account removes your profile, chats, memories, progress, certificates, reports and files after re-authentication." },
      { t: "h2", text: "Who is THAMJJ13.TOP?" },
      { t: "p", text: "THAMJJ13.TOP is the development company behind MATRIX, and its White Hat Team operates the platform's security and safety operations." },
    ],
  },
  {
    slug: "safety",
    title: "Safety",
    icon: "🚨",
    blocks: [
      { t: "p", text: "MATRIX is built to be a safe place — technically and emotionally. If something bad happened online, you are not in trouble and you are not alone." },
      { t: "h2", text: "I Need Help Now" },
      { t: "p", text: "The /emergency page gives immediate defensive steps for: a hacked account, a suspicious link you clicked, an OTP you shared, money lost, a compromised social account, suspicious software, online threats or blackmail, and exposed personal information." },
      { t: "h2", text: "Telling a trusted adult" },
      { t: "p", text: "For anything serious — especially threats, blackmail or money lost — tell a trusted adult immediately. MATRIX can guide you, but adults and authorities can act." },
      { t: "h2", text: "The platform's rules" },
      { t: "ul", items: [
        "Defensive guidance only — no operational help for harmful activity.",
        "No judgment, no fear-based language — calm, clear steps.",
        "Prompt-injection attempts are defended: the assistant always stays MATRIX.",
        "Sensitive data is redacted before AI, and refused topics never reach the model.",
      ]},
    ],
  },
];

export const DOC_INDEX = DOC_SECTIONS.map((s) => ({
  slug: s.slug,
  title: s.title,
  icon: s.icon,
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
