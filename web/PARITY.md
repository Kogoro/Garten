# React rewrite – parity checklist (branch `react-rewrite`)

Reference: the vanilla app in `public/` (v0.7.0, frozen on `main`) and its 99 UI checks in `tests/ui.test.mjs`.
Strategy: same routes (hash), same CSS class names / aria labels, so the existing Playwright checks can be re-pointed at the React build with few changes.

Run: `cd web && npm run build && node e2e/smoke.mjs` · unit tests: `npm test` · dev: `npm run dev` (proxy to :3000).

| Area | Status |
|---|---|
| Shared modules (`shared/`: glossary, import parser, spec types, block model) used by server + web | done |
| Offline store + sync engine (IndexedDB, outbox, conflicts) – typed port | done (ported 1:1, not yet UI-tested) |
| Login, sync pill, shell (sidebar / tabbar) | done (team switcher, account menu, theme menu open) |
| Spec list (search, status + type filter, chips, agent chip) | done |
| Spec editor: BlockNote blocks, slash menu, Markdown view, requirement/diagram/endpoint/definition blocks | done (spike level) |
| Markdown round trip (bit-identical to the vanilla serializer) | done, unit-tested (`src/editor/convert.test.ts`) |
| Endpoint block with tabs (Description / Request / Responses) | done |
| Diagram block Diagram / Code / Split (bundled Mermaid, lazy chunk) | done |
| Editor chrome: approve button, docs dropdown (link documents), item menu (move/delete), `@` doc reference, conflict banner/sheet | todo |
| Documents page (foundation docs, folder tree, folder actions, move/rename) | todo |
| Glossary master/detail (folders, aliases, refs, import from global, update from global) | todo |
| Release page, Sync page | todo |
| Account (tokens, OAuth connections, theme), Team page (members, invites, git, spec types), Admin (users, teams, global glossary + file import, mail) | todo |
| Invite landing page, no-team page, OIDC error display | todo |
| PWA: service worker + manifest (offline shell) | todo |
| Spec-type forms with tabs (new capability) | todo |
| Port Playwright suite, remove `public/` + legacy `/shared` route | todo |

Known editor gaps vs. vanilla: code-block info strings after the language are dropped; numbered lists are stored as bullets; drag handle comes from BlockNote.
