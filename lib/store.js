const KEY = "matrix-ai-v1";

export const defaultState = () => ({
  users: [
    {
      id: "u-admin",
      name: "Matrix Admin",
      email: "admin@matrix.ai",
      password: "admin123",
      role: "admin",
      banned: false,
      createdAt: Date.now(),
    },
  ],
  session: null,
  chats: [],
  quizzes: [
    {
      id: "q-owasp",
      title: "OWASP Top 10 fundamentals",
      description: "Core web application risks every defender should know.",
      questions: [
        {
          q: "Which OWASP item covers unsanitized database queries?",
          options: ["Broken Access Control", "Injection", "SSRF", "Insecure Design"],
          a: 1,
        },
        {
          q: "MFA primarily reduces risk of:",
          options: ["DDoS", "Credential stuffing / account takeover", "SQL injection", "Race conditions"],
          a: 1,
        },
        {
          q: "Least privilege means:",
          options: [
            "Everyone gets admin for speed",
            "Grant only the access needed for a task",
            "Disable logging",
            "Share one service account",
          ],
          a: 1,
        },
      ],
    },
  ],
  certificates: [],
  attempts: [],
});

export function loadState() {
  if (typeof window === "undefined") return defaultState();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      const s = defaultState();
      localStorage.setItem(KEY, JSON.stringify(s));
      return s;
    }
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

export function saveState(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function uid(p = "id") {
  return `${p}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function generateTitle(messages) {
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!userText) return "New briefing";
  const lower = userText.toLowerCase();
  const themes = [
    [/phish|spear|email scam/, "Phishing defense"],
    [/ransom|encrypt.*file|locker/, "Ransomware response"],
    [/zero.?day|cve-|exploit/, "Exploit & CVE analysis"],
    [/siem|soc|alert|splunk/, "SOC / SIEM operations"],
    [/iam|mfa|sso|identity/, "Identity & access"],
    [/malware|trojan|rat|c2/, "Malware analysis"],
    [/network|firewall|ids|ips/, "Network defense"],
    [/cloud|aws|azure|gcp|s3/, "Cloud security"],
    [/owasp|xss|sqli|csrf/, "AppSec / OWASP"],
    [/forensic|incident|ir play/, "Incident response"],
    [/pentest|red team|payload/, "Offensive security briefing"],
    [/zero trust|ztna/, "Zero Trust architecture"],
    [/crypto|tls|certificate|pki/, "Cryptography & PKI"],
    [/privacy|gdpr|hipaa/, "Privacy & compliance"],
    [/linux|hardening|cis/, "System hardening"],
  ];
  for (const [re, title] of themes) {
    if (re.test(lower)) return title;
  }
  const words = userText.split(" ").slice(0, 7).join(" ");
  return words.length > 48 ? words.slice(0, 48) + "…" : words;
}
