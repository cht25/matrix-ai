// Locates a Chromium binary for smoke tests: CHROME_PATH, a system install, an
// extracted Sparticuz build, or @sparticuz/chromium's own extractor.
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function chromiumExecutable() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"]) {
    if (existsSync(candidate)) return candidate;
  }
  const extracted = join(process.cwd(), ".cache", "chromium", "chrome");
  if (existsSync(extracted)) return extracted;
  try {
    const chromium = (await import("@sparticuz/chromium")).default;
    const path = await chromium.executablePath();
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}
