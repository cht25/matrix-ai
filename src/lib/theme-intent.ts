// Deterministic theme-gallery intent. Do not rely on the LLM for this.

const THEME_INTENT =
  /(?:change|switch|show|pick|choose|set|update)\s+(?:your\s+|the\s+|my\s+|this\s+)?theme|\bthemes?\b(?:\s+(?:gallery|templates?|options?|please))?|make (?:it|this|the (?:ui|app|site)) (?:dark(?:er)?|light(?:er)?|midnight|ocean|aurora|forest|carbon)|থিম(?:\s*(?:পরিবর্তন|বদল|চেঞ্জ|দেখাও|গাঢ়|হালকা))?|theme (?:change|kor|koro|daw|dao)/i;

export function isThemeIntent(input: string): boolean {
  const text = input.trim();
  if (!text || text.length > 240) return false;
  return THEME_INTENT.test(text);
}

export const THEME_GALLERY_REPLY_EN =
  "Here are MATRIX theme templates. Each one only applies to your account — other users keep their own look. Pick a palette below, or reset to the default.";

export const THEME_GALLERY_REPLY_BN =
  "এখানে ম্যাট্রিক্স থিম টেমপ্লেটগুলো আছে। যেটি বেছে নেবেন সেটি শুধু আপনার অ্যাকাউন্টে লাগবে। নিচে একটি প্যালেট বেছে নিন, অথবা ডিফল্টে ফিরে যান।";
