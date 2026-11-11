# Design system

Everything visual comes from the tokens at the top of `web/src/styles.css`. Change a token there and every screen follows (light, dark and "system" are three sets of the same names).

| Group | Tokens | Rule |
|---|---|---|
| Surfaces | `--bg` `--panel` `--nav` `--tint` `--scrim` | Page = `--bg`, cards and sheets = `--panel` |
| Lines | `--line` (hairlines) `--line2` (controls) | Controls have `--line2` borders |
| Text | `--text` `--soft` `--muted` `--ph` | Body `--text`; helper text `--muted` (≥ 4.5:1); placeholders `--ph` (≥ 4.5:1) |
| Status | `--green*` ok · `--amber*` waiting · `--red*` problem · `--blue*` info | Colour is never the only signal: every status has text or an icon |
| Type | `--sans` `--display` `--mono` | Two families plus a monospace for ids and code |
| Size | `--ctl` 40 px (buttons, fields, tappable rows), `--ctl-s` 32 px (chips, small buttons), `--h` bars | Tap targets are at least 40 px, dense ones 32 px – above WCAG 2.2 AA (24 px) |
| Shape | `--r` 10 px (buttons, fields, cards, rows), `--r-s` 6 px (chips), pills | One radius per kind of thing |
| Colour roles | green = primary action and "fine"; amber = waiting for you; red = problem | **Quiet when fine, loud when not**: the sync indicator is a grey check until something needs attention |
| Header | title left; one add button (icon only on phones), one sync glyph, one team button | Same on every list screen; no floating action button |

Components (class names): `.btn` (`.primary`, `.danger`, `.small`), `.chip` (`.ok`, `.warn`, `.bad`), `.pill`, `.card` (`.warn`, `.bad`), `.row` (list item), `.field`, `.filter`, `.sheet` (dialog with title, close button and focus trap), `.hint-card` (one-time tip), `.onb` (checklist), `kbd`. New screens use these; a new component gets a token-based style next to them.

Rules the audit enforces (`npm run ux-audit`): contrast and structure by axe-core (WCAG 2.2 AA), one `h1`, a `main` landmark, a skip link and a distinct title per page, visible focus, touch targets and input text size on phones, no horizontal overflow, long words wrap, first-screen budget on a slow phone (LCP < 2.5 s, CLS < 0.1, 300 KB), security headers.

Words: see `UI-VOCABULARY.md`.
