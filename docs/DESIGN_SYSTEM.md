# Design system

How the interface is styled, and the rules that keep it consistent.

## Files

| File | Holds |
|---|---|
| `src/styles/tokens.css` | Every colour, radius, space, font size and duration, for both themes and the optional theme templates. Also maps the tokens to Tailwind (`text-ink`, `bg-surface`, `text-accent`, …) |
| `src/styles/base.css` | Page ground, background glow, element defaults, focus ring, scrollbars |
| `src/styles/components.css` | Shared primitives: card, field, button, chip, eyebrow, brand lockup |
| `src/styles/navigation.css`, `chat.css`, `certificate.css` | Styles that belong to one area |
| `src/styles/utilities.css` | A few animations and helpers |
| `src/components/ui.tsx` | The React primitives: `Button`, `Input`, `Select`, `Textarea`, `Field`, `Card`, `Badge`, `Alert`, `Progress`, `EmptyState`, `ErrorState`, `Skeleton` |
| `src/components/dialogs.tsx`, `modal.tsx` | Confirmation and prompt dialogs |

Colours and brand artwork are described in [BRAND.md](./BRAND.md).

## The one rule about layers

Tailwind 4 puts its utilities in a CSS cascade layer. **Any rule outside a layer
beats every rule inside one, whatever its specificity.** So a hand-written
`p { margin: 0 }` outside a layer silently cancels `mt-2` on every paragraph,
and an unlayered `.card { padding: … }` cancels `p-6` on every card.

That is what used to happen here. Margins on paragraphs, sizes and colours on
headings, colours and underlines on links, state colours on chips and cards,
and padding on fields were written in the markup and never applied.

The rule now:

- **Defaults go in a layer.** Element defaults (`h1`–`h4`, `a`, focus radius)
  are in `@layer base`. The base look of a shared primitive (`.card`,
  `.input-base`, `.btn`, `.chip`, `.eyebrow`, `.mono`, the brand lockup) is in
  `@layer components`. A utility on the call site therefore wins:
  `<Card className="p-4">`, `<Input className="pl-9">`,
  `chip bg-success-soft text-success`, `<Button className="text-xs">`.
- **What must not be overridden stays outside a layer**: variants
  (`.btn-primary`), states (`:focus`, `:disabled`, `[aria-pressed]`), the
  keyboard focus outline, the 16 px minimum font size for fields on phones
  (prevents iOS zoom), and anything that reacts to the app's own state.

When adding a rule, ask which of the two it is.

`Card` adds its default 20 px padding only when the caller passes no padding
utility, so a caller's padding replaces the default instead of competing with
it.

## Type scale

| Use | Size | Markup |
|---|---|---|
| Page title | 28 px (36 px from 640 px wide where the page asks for it) | `<h1 className="text-2xl sm:text-3xl …">` |
| Section or card title | 17 px | `<h2>` default |
| Sub-heading | 15 px | `<h3>` default |
| Body | 15 px | default |
| Secondary text | 13 px | `text-sm` |
| Small print, metadata | 12 px | `text-xs` |
| Eyebrow | 11 px capitals, letter-spaced | `.eyebrow` |

A heading that should be another size says so with a `text-*` utility. Text
colours are `text-ink` (primary), `text-ink-2` (secondary) and `text-ink-3`
(muted).

## Colour in controls

An accent has a text colour and a fill colour (see BRAND.md):

- text, icons, borders, tints: `text-accent`, `border-accent`, `bg-accent-soft`
- filled controls: `bg-accent-solid text-accent-ink` (or `.btn-primary`)

Destructive fills use `.btn-danger`, which draws on `--danger-solid`.

## Interaction

- Touch targets are at least 44 px on phones; buttons are 40 px from 640 px
  wide.
- A keyboard focus indicator is always visible (an outline, or a ring on fields); no utility can remove it.
- Dialogs never use the browser's `confirm()` or `prompt()`. Use `useDialogs()`:
  it returns `confirm()`, `prompt()` (text or password) and an element to
  render. A dialog opens with focus on its field, or on *Cancel* for a
  confirmation.
- Motion is short and optional: every animation is disabled under
  `prefers-reduced-motion`.
- A link styled as a button is a link with `btn` classes
  (`<Link className="btn btn-primary">`), never a button inside a link.

## Layouts that adapt

- The chat welcome screen measures the space it really has (a size container
  query) and drops its least important parts until it fits, so it never opens
  scrolled past its own logo.
- The mobile top bar keeps the wordmark on every common phone width (340 px and
  up); below that only the emblem remains, and the status label shortens with
  an ellipsis.
- Tables in the admin console become cards below the `xl` breakpoint.

## Checking a change

Run the app in development and open the previews (see the README's
"Development previews"). `/dev-preview/app` shows the frame and every primitive
together; switch the theme with the toggle and check 320, 390 and 1440 px
widths. The previews render the real components, so what you see is what
ships.
