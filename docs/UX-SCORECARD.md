# UX scorecard

How the interface measures up against two checklists: the *Enterprise UX Design Guide 2026* (fuselabcreative.com) and the *Website Design Checklist 2026* (tobeworks.de). Neither gives numbers, so the score below is a judgement; **the automated part is `npm run ux-audit`** (it prints findings and a score per area and fails on any finding).

## What a script can see (ux-audit)

Accessibility (axe-core WCAG 2.2 AA + best practice, 4 viewports × 10 pages), keyboard (focus rings, Ctrl/⌘ K, `?`), layout (overflow, long words, 16 px text), touch (44 px, 16 px inputs), semantics (h1, main, skip link, titles), security headers, metadata and icons, first-load performance on a slow phone, console errors.

## What it cannot see (and what is still open)

| Needs | Why a script cannot do it | Status |
|---|---|---|
| Screen-reader walk-through (NVDA, VoiceOver, TalkBack) | automated tools find only about a third of problems (the tobeworks list says the same) | **not done** |
| Test with real users in their jobs (guide 5.1, 5.5) | needs people | **not done** |
| Wording and tone of every message | judgement | reviewed once, vocabulary guarded by a test |
| Real devices (touch, iOS keyboard, notch) | no device available | untested; layout is measured at 320, 390, 1280 and 1440 px |
| Live view of what an agent does right now | agents only report; there is no stream | not built; *Agents at work* shows their last report |
| Table features (column choice, sticky headers) | lists are cards, not tables | not built; sorting, saved filters and density are |

## Mapping

| Guide item | Where it is met |
|---|---|
| Don't lose work on timeouts (EUX 5.3, 9.4), continuity across devices (10.4) | offline-first store, queue, sync, session-expiry state |
| Progressive disclosure (2.3, 9.2) | Garden: needs-you first, report details in a sheet, *Team health* collapsed |
| Role-based visibility (4.6) | controls hidden by role, server enforces |
| Contextual onboarding (6.1) | one-time hints next to the task, getting-started checklist |
| Helpful errors, edge cases (6.2) | specific messages, error boundary, empty states |
| One term per concept (6.3) | `UI-VOCABULARY.md` + `vocabulary.test.mjs` |
| Document the why (6.4) | `docs/`, README, review notes |
| Design system (7.x) | tokens and components in `DESIGN-SYSTEM.md` |
| Keyboard first (9.6) | Ctrl/⌘ K palette, `g`-shortcuts, `?` list, skip link, visible focus |
| Stress test with real data (9.5) | audit seeds 120 specs and 90-character words |
| Agents: visibility, explanation, stopping (10.1) | Garden, reports, checks, decisions; pause/resume agents |
| Personalisation (10.3) | saved sort/filter, density, theme, recent items |
| Measure success (3.x) | *Team health*: figures computed on the server, nothing sent out |
| Performance (tobeworks 1) | first screen 143 KB gzip, LCP 1.5 s on a slow phone (measured), assets cached and compressed |
| Mobile (tobeworks 2) | 44 px targets, 16 px text and inputs, no horizontal scroll, no hover-only content |
| Accessibility (tobeworks 4) | contrast, labels, focus, landmarks; manual screen-reader test open |
| Security headers (tobeworks 5) | CSP, frame-ancestors, nosniff, referrer and permissions policy |
| Favicon / touch icons (tobeworks 7) | SVG + PNG 192/512/180 + maskable |
| Skeletons for loading (tobeworks 7) | boot skeleton, editor skeleton |
| Not applicable | SEO, sitemap, Open Graph, cookie banner, legal pages (a private app behind a login; no tracking at all) |
