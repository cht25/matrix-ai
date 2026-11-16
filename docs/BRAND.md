# QORVYNA brand

| | |
|---|---|
| Name | **QORVYNA** — always in capitals |
| Assistant | **QORVYNA AI** (in Agent mode: **QORVYNA Agent**) |
| Tagline | **ONE INTELLIGENCE. INFINITE POSSIBILITIES.** |
| Concept | Quantum-Oriented Responsive Virtual Intelligence Network Architecture |
| Ecosystem | AI · Agents · IoT · Robotics · Automation · Cloud · Developers |
| Operator | THAMJJ13.TOP White Hat Team |
| Former name | MATRIX (see [REBRAND_MIGRATION.md](./REBRAND_MIGRATION.md)) |

The concept line is the brand's own reading of the name. It is not a technical
claim: nothing in the product uses quantum computing, and the assistant is told
never to say so.

## One source

`src/lib/brand.ts` is the only place the name, tagline, concept, descriptions,
ecosystem list, colours and asset paths are written. Page metadata, the web
manifest, the logo components, e-mail templates and the assistant's identity
(`src/lib/ai/identity.ts`) all read from it. Changing the tagline is a one-line
edit there.

The ecosystem list carries a status per area. Six are `live`. **Robotics is
`planned`**: it belongs to what QORVYNA is about, and no robotics feature
exists in the code yet. Brand surfaces (social card, the assistant's
introduction) name the whole ecosystem; anything that describes what the
product does today lists the live areas only, and the assistant is instructed
to say a planned area is not available when asked.

## The logo

Built from the supplied artwork: a bold **Q** whose ring runs from cyan through
blue to violet, with a diagonal tail, crossed by a tilted orbit that passes
behind the ring on its far side and in front on its near side, and a small
glowing body on the orbit. The wordmark is a wide geometric **QORVYNA** with a
blue accent in the Q's tail and the A's counter.

Everything is vector geometry, defined once in `scripts/brand/geometry.mjs`.
No font is needed to draw the wordmark and nothing is traced from a bitmap, so
the in-app logo, every exported file and every app icon show the same shapes.

Regenerate all artwork with:

```bash
npm run brand:assets     # node scripts/generate-brand-assets.mjs
```

One run rewrites:

| Output | Used for |
|---|---|
| `src/lib/brand-geometry.json` | Shapes and palette for the in-app `<Logo>` |
| `public/brand/qorvyna-logo-{dark,light}.svg` (+ `.png`) | Stacked logo with tagline |
| `public/brand/qorvyna-horizontal-{dark,light}.svg` | Emblem beside the wordmark |
| `public/brand/qorvyna-compact-{dark,light}.svg` | Tight lockup for small headers |
| `public/brand/qorvyna-wordmark-{dark,light}.svg` | Wordmark alone |
| `public/brand/qorvyna-emblem.svg` (+ `.png`, `.webp`), `qorvyna-emblem-small.svg` | Emblem; the small variant drops the orbit for sizes under 48 px |
| `public/brand/qorvyna-mono-{black,white}.svg`, `qorvyna-emblem-mono-{black,white}.svg` | One-colour versions |
| `public/brand/qorvyna-app-icon.svg` | App icon master |
| `public/brand/qorvyna-social-preview.png` (+ `.webp`) | Link preview, 1200 × 630 |
| `public/brand/qorvyna-email-header.png`, `qorvyna-splash.png` | E-mail header, splash |
| `public/favicon.ico`, `favicon.svg`, `favicon-{16,32,48}.png`, `apple-touch-icon.png`, `icon-{192,512}.png`, `icon-maskable-{192,512}.png` | Browser and installed-app icons |
| `src-tauri/icons/*` | Desktop app icons |
| `mobile/matrix_app/…/mipmap-*/ic_launcher.png`, `mobile/matrix_wear/…/mipmap-*/ic_launcher.png` | Android and Wear OS launcher icons |

In the app, use the components in `src/components/logo.tsx` rather than image
files: `QorvynaMark`, `QorvynaWordmark`, `Logo` (emblem + wordmark, optionally a
link), `BrandLockup` (stacked, with tagline) and `BrandTagline`. The wordmark
takes its colour from the surrounding text, so it is correct on any surface in
either theme.

### Using it

- Keep clear space around the logo of at least the height of the wordmark's
  letters.
- Under 48 px use the small emblem; do not shrink the full emblem until the
  orbit turns to blur.
- On a photograph or a busy background use a one-colour version.
- Do not recolour the gradient, stretch, rotate or outline the logo, and do not
  set the name in another typeface next to it.

## Colour

| Name | Hex | Role |
|---|---|---|
| Cyan | `#22CCFF` | Gradient start, highlights |
| Blue | `#2563FF` | Primary: filled buttons, selected states |
| Deep blue | `#1437D6` | Gradient depth |
| Violet | `#7C3AED` | Gradient end, secondary accent |
| Bright violet | `#9D5CFF` | Orbit highlight |
| Navy | `#070B1E` | Dark ground |
| Raised navy | `#0D1433` | Dark surfaces |
| Ink | `#0B1533` | Text on light |
| White | `#F5F8FF` | Text on dark |
| Gray | `#94A3B8` | Secondary text in artwork |

The interface tokens are in `src/styles/tokens.css`. Two rules matter:

1. **An accent has a text colour and a fill colour.** On the dark theme the
   accent used for text, icons and borders is a light blue (`--primary`,
   `#6ea0ff`) that reads on navy. White text on that blue would fail contrast,
   so filled controls use `--primary-solid` (`#2563ff`, 4.9:1 with white). In
   markup: `text-accent` / `border-accent` / `bg-accent-soft` for the first,
   `bg-accent-solid text-accent-ink` for the second. Danger follows the same
   split (`--danger` for text, `--danger-solid` for fills).
2. **State colours are semantic, not brand.** Success, warning and danger keep
   their meanings in both themes.

The dark theme is the default. The background is a flat ground with one static
blue-and-violet glow and a faint grid; its strength is a user setting
(off / subtle / normal / heavy) and it costs a single paint — no animation.

## Voice

- The product is **QORVYNA**; the assistant is **QORVYNA AI**. Do not
  transliterate the name in Bangla text.
- Say what a thing does. Prefer "Publish", "Deploy", "Run with Agent" to
  metaphors.
- Never describe something as done unless a record shows it was done. The
  interface states outcomes with one of: Completed, Failed, Blocked, Awaiting
  approval (and Needs your answer, Paused, Stopped while a task is open).
