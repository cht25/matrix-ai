// =============================================================================
// Digital-life domain + cyber-safety classification.
//
// MATRIX is intentionally permissive: normal questions are sent to the model,
// including Bangla/Banglish and wording that a keyword list does not recognise.
// This pre-filter exists only to stop clearly operational harmful cyber requests.
// =============================================================================

export type Classification = {
  on_topic: boolean;
  topic: string | null;
  harmful: boolean;
  harmful_category: string | null;
  refusal: string | null;
};

// Topic labels are useful for analytics/RAG, but they never act as an allowlist.
// Include common English, Bangla, and Banglish terms so Bangla conversations get
// relevant knowledge-base results instead of being treated as unknown.
const DOMAIN_KEYWORDS: { topic: string; words: string[] }[] = [
  { topic: "phishing_scams", words: ["phish", "scam", "fraud", "fake email", "lottery", "prize", "spam", "suspicious", "প্রতারণা", "স্ক্যাম", "ফিশিং", "ভুয়া", "সন্দেহজনক"] },
  { topic: "account_security", words: ["password", "passphrase", "2fa", "two-factor", "mfa", "account", "login", "hacked", "otp", "secure my", "পাসওয়ার্ড", "অ্যাকাউন্ট", "লগইন", "হ্যাক", "ওটিপি"] },
  { topic: "privacy", words: ["privacy", "private", "tracker", "cookie", "digital footprint", "personal information", "গোপনীয়তা", "ব্যক্তিগত তথ্য", "ডেটা"] },
  { topic: "device_security", words: ["virus", "malware", "ransomware", "update", "device", "app", "download", "backup", "wifi", "wi-fi", "phone", "mobile", "computer", "laptop", "android", "iphone", "software", "hardware", "কম্পিউটার", "ল্যাপটপ", "মোবাইল", "ফোন", "অ্যান্ড্রয়েড", "আইফোন", "অ্যাপ", "সফটওয়্যার", "ভাইরাস", "ওয়াইফাই"] },
  { topic: "social_media", words: ["social media", "instagram", "tiktok", "snapchat", "facebook", "whatsapp", "discord", "profile", "cyberbully", "সোশ্যাল মিডিয়া", "ফেসবুক", "ইনস্টাগ্রাম", "হোয়াটসঅ্যাপ", "সাইবার বুলিং"] },
  { topic: "cyber_education", words: ["hacking", "hacker", "ethical", "white hat", "ctf", "bug bounty", "cybersecurity", "security", "programming", "coding", "website", "internet", "technology", "it support", "সাইবার", "নিরাপত্তা", "প্রোগ্রামিং", "কোডিং", "ওয়েবসাইট", "ইন্টারনেট", "প্রযুক্তি"] },
  { topic: "incident_response", words: ["hacked", "scammed", "lost money", "clicked", "emergency", "account taken over", "হ্যাক হয়েছে", "টাকা হারিয়েছি", "ক্লিক করেছি", "জরুরি"] },
  { topic: "reporting", words: ["report", "reporting", "ftc", "police", "authority", "রিপোর্ট", "পুলিশ", "অভিযোগ"] },
  { topic: "links_messages", words: ["qr code", "sms", "text message", "inbox", "this link", "this email", "this message", "is this real", "কিউআর", "লিংক", "ইমেইল", "মেসেজ", "আসল নাকি"] },
];

type HarmfulRule = { category: string; words?: string[]; re?: RegExp };

// Match explicit harmful intent, not merely security vocabulary. For example,
// “how does ransomware work?” and “remove malware” must remain answerable.
const HARMFUL_KEYWORDS: HarmfulRule[] = [
  { category: "credential_theft", words: ["steal password", "steal credentials", "phishing kit", "credential stuffing", "password crack", "steal otp", "পাসওয়ার্ড চুরি", "ওটিপি চুরি"] },
  { category: "malware", words: ["create malware", "write a virus", "make a virus", "deploy ransomware", "build a keylogger", "give me a keylogger", "keylogger to bypass", "create a botnet", "ম্যালওয়্যার বান", "ভাইরাস বান", "কিলগার বান"] },
  { category: "account_takeover", words: ["take over account", "hijack account", "steal account", "bypass login", "lock someone out", "অ্যাকাউন্ট দখল", "লগইন বাইপাস"] },
  { category: "unauthorized_access", words: ["break into", "hack into", "without permission", "bypass authentication", "hack my school", "hack someone", "hack my brother", "hack my sister", "অনুমতি ছাড়া হ্যাক", "অ্যাকাউন্ট হ্যাক করে", "স্কুল হ্যাক"] },
  { category: "data_theft", words: ["steal data", "steal photos", "steal information", "exfiltrate", "ডেটা চুরি", "ছবি চুরি"] },
  { category: "ddos", re: /(?:how do i|how to|teach me|guide to|help me)\s+(?:a\s+)?ddos|ddos\s+(?:someone|a site|a website|a server)|booter|stresser|flood\s+(?:the|a|their)\s+(?:site|server|website)|(?:ডিডস|ddos)\s*(?:করব|করে দাও|শেখাও)/i },
  { category: "phishing_infrastructure", words: ["clone website for phishing", "fake login page to steal", "phishing site", "ফিশিং সাইট বান", "নকল লগইন পেজ বান"] },
  { category: "evasion", words: ["avoid detection", "evade antivirus", "cover tracks", "undetectable malware", "ধরা না পড়ে হ্যাক", "অ্যান্টিভাইরাস বাইপাস"] },
  { category: "exploitation", words: ["exploit school", "hack school", "cheat grades", "change grades", "steal game account", "free robux", "free v-bucks", "স্কুলের রেজাল্ট বদল", "গেম অ্যাকাউন্ট চুরি"] },
];

const HARMFUL_REFUSAL_PREFIX =
  "I can't help with that request because it could harm someone or access systems without permission. ";

const HARMFUL_REDIRECTS: Record<string, string> = {
  credential_theft: "I can help secure your own passwords, recognise credential theft, and enable two-factor authentication.",
  malware: "I can explain malware safely or help you check and clean a device.",
  account_takeover: "If an account was taken over, I can guide you through recovery and protection.",
  unauthorized_access: "I can teach the same concepts in a legal lab such as TryHackMe or picoCTF.",
  data_theft: "If data was stolen, I can help contain the incident, preserve evidence, and report it.",
  ddos: "I can explain DDoS from a defensive perspective and help protect a service.",
  phishing_infrastructure: "I can teach you to recognise, report, and defend against phishing.",
  evasion: "I can help test defenses in an authorised lab and explain detection safely.",
  exploitation: "I can help recover and secure a school or game account, or practise legally in a sandbox.",
};

/** Short greetings/follow-ups in English, Bangla, and common Banglish. */
export function isGreetingOrFollowup(input: string): boolean {
  const t = input.trim();
  if (!t || t.length > 100) return false;
  return /^(hi+|hii+|hello|hey+|yo|sup|hiya|thanks|thank you|thx|ok|okay|k|yes|yeah|yep|no|nope|please|help|help me|what\??|why\??|how\??|continue|go on|more|and then\??|what next\??|what should i do\??|হাই|হ্যালো|হেলো|সালাম|ধন্যবাদ|ঠিক আছে|আচ্ছা|হ্যাঁ|না|সাহায্য|সাহায্য কর|তারপর|আরও|কি|কেন|কীভাবে|কেমন আছো|ki|keno|kivabe|kemne|valo acho)[\s!.?।]*$/i.test(t);
}

export function classify(input: string): Classification {
  const text = input.toLocaleLowerCase("en");

  for (const h of HARMFUL_KEYWORDS) {
    if (h.re ? h.re.test(input) : h.words?.some((word) => text.includes(word))) {
      return {
        on_topic: true,
        topic: null,
        harmful: true,
        harmful_category: h.category,
        refusal: HARMFUL_REFUSAL_PREFIX + (HARMFUL_REDIRECTS[h.category] ?? "I can suggest a safe, defensive alternative."),
      };
    }
  }

  if (isGreetingOrFollowup(input)) {
    return { on_topic: true, topic: "general_help", harmful: false, harmful_category: null, refusal: null };
  }

  for (const d of DOMAIN_KEYWORDS) {
    if (d.words.some((word) => text.includes(word))) {
      return { on_topic: true, topic: d.topic, harmful: false, harmful_category: null, refusal: null };
    }
  }

  // Unknown is allowed. The model can understand natural language (including
  // Bangla/Banglish) much better than a finite keyword list. It will answer
  // normally and add relevant digital-safety context where useful.
  return { on_topic: true, topic: "general_help", harmful: false, harmful_category: null, refusal: null };
}
