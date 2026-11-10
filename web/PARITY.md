# React rewrite – parity status (branch `react-rewrite`, v0.8.0)

Reference: the vanilla app (v0.7.0, on `main`) and its 99 UI checks. The React build passes the ported suite
(`node web/e2e/ui.test.mjs`, 98 checks; the removed one asserted the old custom drop-line element) plus API (150), OIDC (13) and unit tests (10).

All areas are ported: login, shell/navigation, spec list + editor (BlockNote), documents (folders, foundation), glossary master/detail
(+ global import/update, file import), release, sync, account (tokens, OAuth), team (members, invites, git, spec types), admin, invite page,
no-team page, PWA (offline shell, Mermaid, editor precached).

Open ideas (not part of parity): spec-type forms with tabs per section, visual Mermaid editor, real-device touch testing,
smaller bundle (BlockNote locales / Mantine).
