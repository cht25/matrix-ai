// =============================================================================
// AI domain + cyber-safety classification (spec §22, §23, §46)
// Keyword + heuristic pre-filtering runs BEFORE any LLM call, so off-topic and
// harmful requests are refused without spending a model call.
// =============================================================================

export type Classification = {
  on_topic: boolean;
  topic: string | null;
  harmful: boolean;
  harmful_category: string | null;
  refusal: string | null;
};

// Allowed topics (defensive cybersecurity education only).
const DOMAIN_KEYWORDS: { topic: string; words: string[] }[] = [
  { topic: "phishing_scams", words: ["phish", "scam", "fraud", "fake email", "fake shop", "lottery", "prize", "spam", "suspicious", "strange message", "weird message"] },
  { topic: "account_security", words: ["password", "passphrase", "2fa", "two-factor", "mfa", "account", "login", "hacked", "hijack", "otp", "code", "secure my", "lock down"] },
  { topic: "privacy", words: ["privacy", "private", "tracker", "cookie", "digital footprint", "data", "overshare", "personal information"] },
  { topic: "device_security", words: ["virus", "malware", "ransomware", "update", "device", "app", "download", "backup", "wifi", "wi-fi", "phone", "screenshot"] },
  { topic: "social_media", words: ["social media", "instagram", "tiktok", "snapchat", "facebook", "whatsapp", "discord", "profile", "bully", "cyberbully"] },
  { topic: "cyber_education", words: ["hacking", "hacker", "ethical", "white hat", "ctf", "tryhackme", "bug bounty", "cybersecurity", "security", "defend", "learn", "course", "quiz", "cyber", "online safety", "stay safe"] },
  { topic: "incident_response", words: ["hacked", "scammed", "lost money", "clicked", "shared my", "emergency", "what do i do", "account taken over", "protect me", "protect my"] },
  { topic: "reporting", words: ["report", "reporting", "ftc", "police", "action fraud", "scamwatch", "authority"] },
  { topic: "links_messages", words: ["qr code", "qr-code", "sms", "text message", "inbox", "this link", "this email", "this message", "is this real", "is this fake"] },
];

// Harmful categories that must be refused and redirected to defensive help.
// `words`: simple substring checks (checked in order).
// `re`: a regular expression checked first for ambiguous categories (e.g. DDoS
// discussion vs. "how to DDoS").
type HarmfulRule = { category: string; words?: string[]; re?: RegExp };

const HARMFUL_KEYWORDS: HarmfulRule[] = [
  { category: "credential_theft", words: ["steal password", "steal credentials", "phishing kit", "credential stuffing", "password crack", "keylogger", "steal otp", "steal code"] },
  { category: "malware", words: ["create malware", "write a virus", "make a virus", "ransomware", "trojan", "spyware", "keylogger", "botnet", "remote access trojan"] },
  { category: "account_takeover", words: ["take over account", "hijack account", "steal account", "bypass login", "reset someone", "lock someone out"] },
  { category: "unauthorized_access", words: ["break into", "hack into", "unauthorized", "without permission", "bypass authentication", "exploit school", "hack my school", "hack someone", "hack my brother", "hack my sister"] },
  { category: "data_theft", words: ["steal data", "steal photos", "steal information", "exfiltrate", "dump someone"] },
  {
    category: "ddos",
    re: /(?:how do i|how to|teach me|guide to|help me)\s+(?:a\s+)?ddos|ddos\s+(?:someone|a site|a website|a server)|booter|stresser|flood\s+(?:the|a|their)\s+(?:site|server|website)/i,
  },
  { category: "phishing_infrastructure", words: ["clone website", "fake login page", "phishing site", "spoof email", "email spoofing", "sms spoofing"] },
  { category: "evasion", words: ["avoid detection", "evade antivirus", "hide from", "cover tracks", "anonymize attack", "undetectable malware"] },
  { category: "exploitation", words: ["exploit school", "hack school", "cheat grades", "change grades", "hack game", "steal game account", "free robux", "free v-bucks", "crack game"] },
];

const DEFAULT_REFUSAL =
  "I can only help with cybersecurity, online safety, privacy, scam awareness, and related topics.";

const HARMFUL_REFUSAL_PREFIX =
  "I can't help with that. Even when something feels unfair or tempting, using harmful tactics can hurt people and get you into serious trouble. ";

const HARMFUL_REDIRECTS: Record<string, string> = {
  credential_theft: "If you're worried about your own passwords, I can show you how to create strong ones and turn on two-factor authentication.",
  malware: "If you think your device has malware, I can walk you through removing it safely.",
  account_takeover: "If your account was taken over, I can give you the exact steps to recover it.",
  unauthorized_access: "If you want to learn hacking skills the right way, I can point you to legal sandboxes like TryHackMe and picoCTF.",
  data_theft: "If someone stole your data, I can help you report it and lock things down.",
  ddos: "If a site is under attack, I can explain how DDoS attacks work from a defensive perspective.",
  phishing_infrastructure: "I can teach you how to recognise phishing so you never fall for it.",
  evasion: "I can help you clean up your device and secure it against real threats.",
  exploitation: "If a game or school account was compromised, I can help you report it and secure it.",
};

/** Short greetings / follow-ups so the assistant can start or continue a safety chat. */
export function isGreetingOrFollowup(input: string): boolean {
  const t = input.trim();
  if (!t || t.length > 80) return false;
  return /^(hi+|hii+|hello|hey+|yo|sup|hiya|thanks|thank you|thx|ok|okay|k|yes|yeah|yep|no|nope|please|help|help me|what\??|why\??|how\??|continue|go on|more|and then\??|what next\??|what should i do\??|ok thanks)[\s!.?]*$/i.test(t);
}

export function classify(input: string): Classification {
  const text = input.toLowerCase();

  // Harmful first (a request can mention both domains).
  for (const h of HARMFUL_KEYWORDS) {
    if (h.re ? h.re.test(input) : h.words?.some((w) => text.includes(w))) {
      return {
        on_topic: true,
        topic: null,
        harmful: true,
        harmful_category: h.category,
        refusal: HARMFUL_REFUSAL_PREFIX + (HARMFUL_REDIRECTS[h.category] ?? "I can point you to safe, defensive alternatives."),
      };
    }
  }

  if (isGreetingOrFollowup(input)) {
    return { on_topic: true, topic: "cyber_education", harmful: false, harmful_category: null, refusal: null };
  }

  for (const d of DOMAIN_KEYWORDS) {
    if (d.words.some((w) => text.includes(w))) {
      return { on_topic: true, topic: d.topic, harmful: false, harmful_category: null, refusal: null };
    }
  }

  return { on_topic: false, topic: null, harmful: false, harmful_category: null, refusal: DEFAULT_REFUSAL };
}
