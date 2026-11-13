# Design system

Everything visual comes from the tokens at the top of `web/src/styles.css`. Change a token there and every screen follows (light, dark and "system" are three sets of the same names).

| Group | Tokens | Rule |
|---|---|---|
| Surfaces | `--bg` (canvas) `--panel` (cards, sheets) `--nav` `--tint` (hover, quiet fills) `--scrim` | Light is the base; dark and "system" redefine the same names. Neutrals are tinted towards the brand green. |
| Lines | `--line` (hairlines, 8 % black or white) `--line2` (control borders) | One 1 px solid border everywhere. Controls keep the stronger `--line2` |
| Text | `--text` `--soft` `--muted` `--ph` | Body `--text`; helper text `--muted` (≥ 4.5:1); placeholders and timestamps `--ph` (≥ 4.5:1) |
| Accent | `--accent` `--accent-hover` `--on-accent` | Moss green, **only** for the primary button, focus rings, interactive text links and the active navigation (sidebar item, tab bar, tabs). Never for fills, badges, headings or "fine" states |
| Status | `--amber*` waiting · `--red*` problem | Colour is never the only signal: every status has text or an icon. "Fine" is neutral (quiet when fine, loud when not) |
| Type | `--sans` `--mono` | One sans family (system stack, no web font) plus a monospace for ids and code. Weights 400 / 500 / 600 |
| Spacing | `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-6` 24 · `-8` 32 · `-12` 48 px | Gaps, padding and margins use these values only |
| Size | `--ctl` 40 px (buttons, fields, tappable rows), `--ctl-s` 32 px, `--h` bars; 48 px icon buttons on phones | Tap targets are at least 40 px, 44 px where the audit measures phones |
| Shape | `--radius-lg` 12 px (containers: cards, sheets, menus) · `--radius-md` 8 px (buttons, fields, rows, chips) | Concentric: inner radius = outer radius − padding |
| Elevation | `--shadow-card` (two soft layers) · `--shadow-pop` (menus, dialogs, toast) | No hard dark shadows |
| Motion | `--ease-out` `cubic-bezier(.16, 1, .3, 1)` · `--t-in` 200 ms · `--t-out` 130 ms | Menus scale 0.96 → 1 from their trigger, dialogs grow out of the button that opened them, toasts slide in. Menus and toasts leave in 130 ms, dialogs leave at once. No linear or ease-in-out |
| Hierarchy | one primary action per view | Everything else is a hairline button, a ghost button or a text link; never two solid buttons side by side |
| Header | title left; sync status as a dot (grey = on the server, amber = waiting, red = needs you); team button on phones | Same on every screen |
| Add | **Phone:** floating button bottom right above the navigation (`Fab`). **Desktop:** labelled button in the header. | Never both: mobile patterns stay off the desktop and the other way round (the audit checks it) |
| Tabs | Pages with several sections (Members & Git, Admin, Account) use tabs | Same on phone and desktop; arrow keys switch |

Type roles: page title 24 px / 600 (18 px in the one-row phone bar) · section 16–18 px / 600 · card and row title 14 px / 600 · body 14 px (16 px on phones, iOS zooms into smaller fields) · meta 13 px · caption 12 px / 500.

Components (class names): `.btn` (`.primary`, `.danger`, `.small`), `.chip` (`.ok`, `.warn`, `.bad`), `.pill`, `.card` (`.warn`, `.bad`), `.row` (list item), `.field`, `.filter`, `.sheet` (dialog with title, close button and focus trap), `.hint-card` (one-time tip), `.onb` (checklist), `kbd`. New screens use these; a new component gets a token-based style next to them.

Rules the audit enforces (`npm run ux-audit`): contrast and structure by axe-core (WCAG 2.2 AA), one `h1`, a `main` landmark, a skip link and a distinct title per page, visible focus, touch targets and input text size on phones, no horizontal overflow, long words wrap, first-screen budget on a slow phone (LCP < 2.5 s, CLS < 0.1, 300 KB), security headers.

Words: see `UI-VOCABULARY.md`.

**Platform patterns.** Phone only: floating add button, bottom navigation, read-first editor with *Edit/Done*, approval bar, overview strip, sort/filter sheet. Desktop only: sidebar, labelled header buttons, sync status with words, side-by-side list and editor. Shared: tokens, chips, cards, tabs, sheets, the command palette.

## Where the app deviates from the UI Design Specification

The design follows the specification (`docs/mockup.html`, `docs/prototype.html`). Where an existing rule of the app or the accessibility audit says otherwise, the app rule wins and is listed here.

| Specification | In the app | Why |
|---|---|---|
| Body 14 px | 14 px on desktop, **16 px on phones** | The audit requires 16 px text and inputs on phones (iOS zooms into smaller fields) |
| Page title 24–28 px | 24 px on desktop; the phone **bar** title is 18 px, the editor bar title 18 px | The bar is one row high and the title is ellipsised; 24 px does not fit next to the approve button |
| Tertiary text `#8A948F` (light) / `#6B7280` (dark) | `--ph` `#66706B` / `#8A948F` | The specified values are 3.1:1 and 3.7:1; the app promises 4.5:1 for placeholders and meta text |
| Borders 8 % black/white | hairlines and cards: 8 %; **controls** (`.field`, `.search`): `--line2` | Field boundaries need to be visible; 8 % is far below the 3:1 of WCAG 1.4.11 (`--line2` is still below it, as before) |
| Fonts: Inter plus optional mono, loaded from a font service | Inter if installed, else the system stack; no web font | Self-hosted, offline-first, strict CSP: no third-party font host |
| Dropdowns and dialogs animate out in 120–150 ms | menus and the toast: 130 ms; **dialogs close at once** | A delayed unmount re-opened the previous dialog's state in fast sequences (and breaks keyboard focus return) |
| Heights from the spacing scale | controls are 40 / 32 / 48 px | Touch targets; all are multiples of 8 |
| Large dividers via `<hr>` only when needed | rows keep their hairlines in lists | Lists are scanned; without lines rows run together |
