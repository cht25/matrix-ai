// =============================================================================
// MATRIX design-quality validation
//
// `validateProject` answers "will this build and serve?". This module answers
// "is the page any good to look at and use?" — the checks a successful build
// never proved:
//
//   responsive     viewport meta, media queries / responsive utilities
//   navigation     a multi-link nav has a small-screen pattern that works
//   overflow       fixed widths that force horizontal scrolling on phones
//   contrast       declared text/background pairs below WCAG AA
//   images         placeholder services, missing alt text, missing sizing
//   content        empty sections, lorem ipsum, effectively blank pages
//   pages          pages the design specification promised but are missing
//   links          in-page anchors that point at nothing
//
// Static analysis only — this host has no headless browser, so runtime console
// errors and real rendering are reported as NOT checked rather than passed.
// Pure module: no network, no Firestore. Unit tested.
// =============================================================================

import type { ProjectFile } from "@/lib/projects/paths";
import type { BuildCheck, BuildIssue } from "@/lib/deploy/validate";
import { contrastRatio } from "@/lib/design/tokens";

export type DesignQualityOptions = {
  /** Page names from the design specification ("Pricing", "Contact"…). */
  expectedPages?: string[];
  /** True when the user explicitly asked for separate pages. */
  requirePages?: boolean;
};

const HTML_RE = /\.html?$/i;
const CSS_RE = /\.css$/i;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ");
}

function visibleText(html: string): string {
  return stripNonContent(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
}

function hexColor(value: string): string | null {
  const m = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.exec(value);
  if (!m) {
    const named = /\b(white|black)\b/i.exec(value);
    return named ? (named[1].toLowerCase() === "white" ? "#ffffff" : "#000000") : null;
  }
  const raw = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${raw.toLowerCase()}`;
}

/** Text/background pairs declared together in one CSS rule. */
function declaredPairs(css: string): Array<{ selector: string; fg: string; bg: string; index: number }> {
  const pairs: Array<{ selector: string; fg: string; bg: string; index: number }> = [];
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) {
    const value = hexColor(m[2]);
    if (value && !/gradient|url\(/i.test(m[2])) vars.set(m[1], value);
  }
  const resolve = (value: string): string | null => {
    if (/gradient|url\(|rgba?\(|hsla?\(|transparent|inherit|currentcolor/i.test(value)) return null;
    const ref = /var\((--[\w-]+)/.exec(value);
    if (ref) return vars.get(ref[1]) ?? null;
    return hexColor(value);
  };
  for (const rule of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const body = rule[2];
    const fgMatch = /(?:^|;|\s)color\s*:\s*([^;]+)/i.exec(body);
    const bgMatch = /background(?:-color)?\s*:\s*([^;]+)/i.exec(body);
    if (!fgMatch || !bgMatch) continue;
    const fg = resolve(fgMatch[1]);
    const bg = resolve(bgMatch[1]);
    if (fg && bg) pairs.push({ selector: rule[1].trim().replace(/\s+/g, " ").slice(0, 60), fg, bg, index: rule.index ?? 0 });
  }
  return pairs;
}

function pageKey(name: string): string {
  return name.toLowerCase().replace(/\.html?$/, "").replace(/[^a-z0-9]+/g, "");
}

export function designQualityCheck(files: ProjectFile[], options: DesignQualityOptions = {}): BuildCheck {
  const issues: BuildIssue[] = [];
  const text = files.filter((file) => file.encoding !== "base64");
  const pages = text.filter((file) => HTML_RE.test(file.path));
  if (!pages.length) {
    return { id: "design", label: "Design quality", status: "skipped", message: "No HTML pages to review.", issues };
  }
  const cssFiles = text.filter((file) => CSS_RE.test(file.path));
  const inlineCss = pages.map((page) => [...page.content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n")).join("\n");
  const allCss = `${cssFiles.map((file) => file.content).join("\n")}\n${inlineCss}`;
  const allSource = text.map((file) => file.content).join("\n");
  const usesTailwind = /cdn\.tailwindcss\.com|@tailwindcss\/browser/i.test(allSource);
  const responsiveUtilities = /\b(?:sm|md|lg|xl):[\w-[\]/.]+/.test(allSource);
  const hasMediaQuery = /@media[^{]*\((?:max|min)-width/i.test(allCss) || /@container/i.test(allCss);
  const fluidLayout = /\b(?:auto-fit|auto-fill|minmax\(|clamp\(|flex-wrap\s*:\s*wrap)/i.test(allCss);

  for (const page of pages) {
    const html = page.content;
    const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
    const words = visibleText(body);
    const media = (stripNonContent(body).match(/<(?:img|svg|canvas|video|picture|iframe)\b/gi) ?? []).length;
    const scripted = /<script\b/i.test(html) && /<(?:div|main)\b[^>]*\bid=["'](?:app|root)["']/i.test(html);

    // --- content --------------------------------------------------------
    if (words.length < 40 && media === 0 && !scripted) {
      issues.push({ path: page.path, severity: "error", message: "The page has no visible content (fewer than 40 characters of text and no media). An empty page is not a finished website." });
      continue;
    }
    if (!/<meta\b[^>]*name=["']viewport["']/i.test(html)) {
      issues.push({ path: page.path, severity: "warning", message: "Missing <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> — the page will render zoomed-out on phones." });
    }
    if (/\blorem ipsum\b/i.test(words)) {
      issues.push({ path: page.path, severity: "warning", message: "Placeholder “lorem ipsum” text is still on the page. Replace it with real content for this site." });
    }
    for (const m of stripNonContent(body).matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gi)) {
      const inner = m[1];
      if (visibleText(inner).length < 3 && !/<(?:img|svg|canvas|video|picture|iframe|form|input)\b/i.test(inner)) {
        issues.push({ path: page.path, line: lineOf(html, html.indexOf(m[0])), severity: "warning", message: "Empty <section> — it renders as a blank band. Fill it or remove it." });
      }
    }
    const h1 = (stripNonContent(body).match(/<h1\b/gi) ?? []).length;
    if (h1 === 0 && words.length > 200) issues.push({ path: page.path, severity: "warning", message: "No <h1> heading — the page has no clear title for users or screen readers." });

    // --- images ---------------------------------------------------------
    for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      const src = /\bsrc=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
      const line = lineOf(html, html.indexOf(tag));
      if (!src.trim() || src === "#") issues.push({ path: page.path, line, severity: "warning", message: "An <img> has an empty src and will show a broken-image icon." });
      else if (/(?:via\.placeholder\.com|placehold\.co|placeholder\.com|dummyimage\.com|placekitten|example\.com\/)/i.test(src)) issues.push({ path: page.path, line, severity: "warning", message: `Placeholder image service used (${src.slice(0, 60)}). Use a real, relevant image or an inline SVG.` });
      if (!/\balt=/i.test(tag)) issues.push({ path: page.path, line, severity: "warning", message: "An <img> has no alt attribute (use alt=\"\" for purely decorative images)." });
    }

    // --- navigation -----------------------------------------------------
    const nav = /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(stripNonContent(body));
    if (nav) {
      const links = (nav[1].match(/<a\b/gi) ?? []).length;
      const hasToggle = /aria-expanded|aria-controls|menu-toggle|nav-toggle|hamburger|mobile-menu|<details\b|data-menu/i.test(html) || /\b(?:md|lg|sm):hidden\b|\bhidden\s+(?:md|lg|sm):(?:flex|block|inline-flex|grid)\b/.test(html);
      const cssHandlesNav = hasMediaQuery && /@media[^{]*max-width[^{]*\{[\s\S]{0,4000}?(?:nav|menu|header)/i.test(allCss);
      const scrollable = /overflow-x\s*:\s*auto|overflow-x-auto|flex-wrap\s*:\s*wrap|flex-wrap/i.test(`${nav[0]}${allCss}`);
      if (links >= 5 && !hasToggle && !cssHandlesNav && !scrollable) {
        issues.push({ path: page.path, severity: "warning", message: `The navigation has ${links} links but no small-screen behaviour (no menu toggle, wrap or media query). It will overflow on phones.` });
      }
    } else if (pages.length > 1 && words.length > 200) {
      issues.push({ path: page.path, severity: "warning", message: "This multi-page site page has no <nav>, so visitors cannot reach the other pages from here." });
    }

    // --- in-page anchors --------------------------------------------------
    const ids = new Set([...html.matchAll(/\b(?:id|name)=["']([^"']+)["']/gi)].map((m) => m[1]));
    const missing = new Set<string>();
    for (const m of body.matchAll(/<a\b[^>]*\bhref=["']#([^"']+)["']/gi)) {
      if (!ids.has(m[1]) && !/^(?:top|!|\/)/.test(m[1])) missing.add(m[1]);
    }
    if (missing.size) issues.push({ path: page.path, severity: "warning", message: `Links point at sections that do not exist on the page: ${[...missing].slice(0, 5).map((id) => `#${id}`).join(", ")}.` });
    const dead = (body.match(/<a\b[^>]*\bhref=["'](?:#|javascript:void\(0\);?|)["']/gi) ?? []).length;
    if (dead >= 4) issues.push({ path: page.path, severity: "warning", message: `${dead} links go nowhere (href="#"). Point them at a real section or page.` });
  }

  // --- responsive (project-wide) -------------------------------------------
  const substantial = pages.some((page) => visibleText(page.content).length > 400);
  if (substantial && !hasMediaQuery && !responsiveUtilities && !fluidLayout) {
    issues.push({ path: cssFiles[0]?.path ?? pages[0].path, severity: "warning", message: "No responsive rules found (no media queries, fluid grid or responsive utility classes). The layout will not adapt to phones and tablets." });
  }
  if (usesTailwind && substantial && !responsiveUtilities) {
    issues.push({ path: pages[0].path, severity: "warning", message: "Tailwind is loaded but no responsive variants (sm:/md:/lg:) are used, so the layout is identical at every width." });
  }

  // --- overflow --------------------------------------------------------------
  for (const file of [...cssFiles, ...pages]) {
    const css = CSS_RE.test(file.path) ? file.content : [...file.content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
    const withoutMedia = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, " ");
    let reported = 0;
    for (const rule of withoutMedia.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const width = /(?:^|;|\s)(?:min-)?width\s*:\s*(\d{3,5})px/i.exec(rule[2]);
      if (!width || Number(width[1]) <= 480) continue;
      if (/max-width\s*:/i.test(rule[2]) && !/min-width\s*:\s*\d{3,5}px/i.test(rule[2])) continue;
      if (/max-width\s*:\s*100%/i.test(rule[2])) continue;
      if (reported++ >= 3) break;
      issues.push({ path: file.path, severity: "warning", message: `${rule[1].trim().replace(/\s+/g, " ").slice(0, 50)} has a fixed width of ${width[1]}px, which forces horizontal scrolling on phones. Use max-width with width: 100%.` });
    }
  }

  // --- contrast ----------------------------------------------------------------
  let contrastReported = 0;
  for (const file of [...cssFiles, ...pages]) {
    const css = CSS_RE.test(file.path) ? file.content : [...file.content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
    for (const pair of declaredPairs(css)) {
      const ratio = contrastRatio(pair.fg, pair.bg);
      if (ratio >= 3) continue;
      if (contrastReported++ >= 5) break;
      issues.push({ path: file.path, severity: "warning", message: `${pair.selector}: text ${pair.fg} on ${pair.bg} has a contrast ratio of ${ratio.toFixed(2)}:1 (minimum 4.5:1 for body text, 3:1 for large text).` });
    }
  }

  // --- expected pages ------------------------------------------------------------
  const expected = (options.expectedPages ?? []).filter((name) => !/^(home|landing|dashboard)$/i.test(name));
  if (options.requirePages && expected.length) {
    const have = new Set(pages.map((page) => pageKey(page.path.split("/").pop() ?? page.path)));
    const absent = expected.filter((name) => {
      const key = pageKey(name);
      return ![...have].some((page) => page === key || page.includes(key) || key.includes(page) && page.length > 3);
    });
    if (absent.length) issues.push({ path: "project", severity: "warning", message: `Requested page${absent.length === 1 ? "" : "s"} missing: ${absent.join(", ")}. Each should be its own .html file linked from the navigation.` });
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return {
    id: "design",
    label: "Design quality",
    status: errors ? "failed" : "passed",
    message: errors
      ? `${errors} blocking design problem${errors === 1 ? "" : "s"}.`
      : `${warnings ? `${warnings} design warning${warnings === 1 ? "" : "s"}` : "Responsive, navigation, contrast, image and content checks passed"} · static analysis only (no browser on this host, so runtime console errors were not checked).`,
    issues: issues.slice(0, 40),
  };
}

/** Warnings worth one automatic improvement pass (not cosmetic nits). */
export function significantDesignIssues(check: BuildCheck): BuildIssue[] {
  return check.issues.filter((issue) => issue.severity === "error" || /viewport|responsive|overflow|horizontal scrolling|contrast ratio|small-screen|no visible content|Empty <section>|lorem ipsum|Placeholder image|page[s]? missing|do not exist/i.test(issue.message));
}
