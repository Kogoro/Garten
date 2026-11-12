# Garten (Specs)

Self-hosted, offline-first App, um auf Handy und Desktop Spezifikationen und Dokumente für KI-Agenten zu schreiben – **pro Team**.
Freigegebene (approved) Specs werden als Markdown in das Git-Repo des Teams geschrieben (Commit + Tag pro Version, Autor = Freigebender),
optional in dessen Entwicklungs-Repository gepusht und über einen **MCP-Server** an Agenten ausgeliefert. Entwürfe bleiben privat.

## Installation

**Docker**

```bash
ADMIN_PASSWORD='mein-passwort' docker compose up -d --build   # ohne ADMIN_PASSWORD: wird erzeugt und im Log angezeigt
docker compose logs specs
```

<http://localhost:3000> → `admin@localhost`. `SEED_DEMO=1` (Default) füllt das erste Team mit Beispieldaten. Konfiguration per Umgebungsvariablen, siehe `docker-compose.yml`.

**Debian 12/13 / Ubuntu 24.04 (VM, Server, LXC), als root:**

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kogoro/Garten/main/scripts/install-debian.sh)"
```

Installiert den **neuesten Release** nach `/opt/garten`, Daten unter `/var/lib/garten/data`, Einstellungen in `/etc/garten/garten.env` (dieselben Variablen wie in `docker-compose.yml`), Dienst `garten` auf `http://<IP>:3000`. Zugangsdaten stehen in `/root/garten.creds`.

| Befehl | |
|---|---|
| `garten update` | auf den neuesten Release aktualisieren (Daten und Einstellungen bleiben) |
| `garten info` · `garten logs` | Adresse, Version, Status · Log |
| `garten backup` | Archiv in `/root` |
| `garten url https://spec.example.org` | eigene Adresse (Reverse-Proxy mit HTTPS) |

`GARTEN_REF=v0.11.0 garten update` installiert eine bestimmte Version, `GARTEN_REF=main` den Entwicklungsstand. Plain HTTP funktioniert nur online – Offline-Modus und Handy-Installation brauchen HTTPS (siehe unten). Nur per VPN erreichbar heißt: Cloud-Routinen von Claude Code erreichen den Server nicht.

## Releases

Version in `package.json` erhöhen, committen, dann Tag setzen und pushen:

```bash
git tag v0.12.0 && git push origin v0.12.0
```

Der Workflow `.github/workflows/release.yml` prüft, dass der Tag zur `package.json`-Version passt, und legt den GitHub-Release mit automatisch erzeugten Notizen an (Tags mit `-`, z. B. `v0.12.0-rc.1`, sind Vorab-Releases und werden von `garten update` nicht gewählt). Ohne veröffentlichten Release bricht `garten update` ab, statt auf `main` auszuweichen.

## Teams, Einladungen, Rollen

* Jeder Nutzer kann ein **eigenes Team** anlegen (`MAX_TEAMS_PER_USER`, abschaltbar mit `ALLOW_TEAM_CREATION=0`) und wird dessen Team-Admin. Alle Daten (Specs, Dokumente, Glossar, Git-Repo, MCP-Zugriff) sind strikt an ein Team gebunden.
* **Einladung** durch den Team-Admin (*Members & Git → Invite people*): E-Mail + Rolle → einmaliger Link, 7 Tage gültig; mit SMTP wird er zusätzlich per Mail verschickt. Offene Einladungen lassen sich erneut senden (*Resend*, alter Link verfällt) und widerrufen.
* Der **Instanz-Admin** verwaltet nur Teams und Konten (Seite *Admin*), lädt aber niemanden ein. Der einzige Admin eines Teams kann nicht gelöscht werden.
* Login per E-Mail/Passwort oder optional OpenID Connect (`OIDC_*`).

| Recht | viewer | editor | approver | admin |
|---|:-:|:-:|:-:|:-:|
| Lesen | ✓ | ✓ | ✓ | ✓ |
| Entwürfe schreiben, löschen; Agent-Scopes `mcp:drafts`/`mcp:write` | | ✓ | ✓ | ✓ |
| Freigeben / zurückziehen / nach Git pushen | | | ✓ | ✓ |
| Mitglieder, Git-Verbindung, Team-Einstellungen | | | | ✓ |

**E-Mail (optional, nur Einladungen und Feedback-Digest):** `SMTP_URL` (`smtp://user:pass@host:587` STARTTLS oder `smtps://…:465`, Sonderzeichen URL-kodieren) und `SMTP_FROM`; `SMTP_REQUIRE_TLS=1` verweigert unverschlüsselten Versand. *Admin → E-mail* schickt eine Testmail. Höchstens 30 Einladungen pro Team und Stunde.

## Specs, Dokumente, Glossar

* **Spec-Typen:** Feature, API, UI, Data model, NFR, Integration, dazu Architecture spec und ADR – jeweils mit Vorlage. Teams definieren eigene Typen (*Members & Git → Spec types*). Der Typ steht im Front-Matter (`type: api`) und ist per MCP filterbar.
* **Formular statt Editor:** Ein Typ kann seinen Inhalt als Formular mit Feldern, Listen und Tabs beschreiben (Feldtypen u. a. Requirements, API-Endpoints, Mermaid-Diagramm, Checkliste). Gespeichert wird immer Markdown (`## FELDNAME`); über das Overflow-Menü wechselt man zwischen **Form**, **Blocks** und **Markdown**. Unbekannte Abschnitte bleiben erhalten („Other content“).
* **Editor:** Blöcke auf Basis von BlockNote (Text, Überschriften, Requirement, Checkliste, Liste, Definition, Zitat, Code, Diagramm, API-Endpoint), `/` öffnet das Block-Menü, `@` verlinkt Dokumente, `#` Glossarbegriffe. Mermaid-Diagramme rendern auch offline; andere Textformate gehen als Code-Block an den Agenten.
* **Foundation-Dokumente:** Jedes Team hat `vision.md`, `strategy.md`, `glossary.md` und `guardrails.md`; weitere lassen sich anheften. Sie gehören keinem Spec, gehen nach der letzten Änderung automatisch live (pro Team umstellbar auf „Publish now“) und landen unter `<Ordner>/docs/`. `get_team_context()` liefert sie Agenten in einem Aufruf.
* **Leitplanken:** Abschnitte *Always* / *Never* (`- G1: …`) in `guardrails.md` sind für Agenten verbindlich; würde eine Aufgabe eine Regel brechen, fragt der Agent per `request_decision`. Aus Feedback oder Abweichungen wird per **Make it a rule** eine Regel.
* **Aus Text ableiten:** Im Menü (⋯) eines Specs oder Dokuments gibt es *New spec from selection / this document…* und *Glossary term from selection / this document…*. Ohne Markierung gilt das ganze Dokument. Beim Spec wählt man Typ und Titel; der Text wird kopiert und bekommt einen Abschnitt `## SOURCE`. Beim Begriff öffnet sich der Glossar-Dialog vorbefüllt (kurze Markierung = Begriff, längere = Definition, ganzes Dokument = Titel und erster Absatz). Enthält ein Dokument schon Definitionen, übernimmt *Add N definitions … to the glossary* sie auf einmal. Das Original bleibt unverändert; Agenten tun dasselbe über `derive_from_document`.
* **Dokumente in Ordnern:** IDs sind Pfade (bis 5 Ebenen), Ordner sind eigene Objekte, Verschieben/Umbenennen zieht Verlinkungen nach.
* **Glossar:** Definition-Blöcke werden als Markdown-Definitionsliste gespeichert (`Term` / `: Definition` / `: Aliases:` / `: See also:`), Verweise mit `[[Begriff]]`. Alle Definitionen freigegebener Specs und Dokumente fließen in `GLOSSARY.md` / `get_glossary`. *Search definitions online* (Wikipedia, Wiktionary, dictionaryapi.dev) schickt nur den Suchbegriff, `LOOKUP=0` schaltet das ab. Instanz-Admins pflegen ein **globales Glossar** (*Admin → Global glossary*, Import aus CSV/JSON/Markdown); Teams importieren Begriffe als editierbare Kopie und sehen *Update available*, wenn das Original sich ändert.

## Git-Verbindung pro Team

*Team → Git connection* (Team-Admin). Jedes Team hat ein eigenes Repo (`/data/repos/<team>`) und optional einen Remote, typischerweise das Entwicklungsprojekt.

| Einstellung | Bedeutung |
|---|---|
| URL | `https://…` oder SSH. `http://` nur mit `GIT_ALLOW_HTTP=1`, private/lokale Adressen nur mit `GIT_ALLOW_PRIVATE=1`; `file://`, `ext::` u. Ä. werden abgelehnt. |
| Branch | Ziel-Branch; vorhandene Commits werden zuerst gemergt (bei Konflikten gewinnt Specs). |
| Ordner | Specs schreibt nur in `<Ordner>/` (Default `specs/`): `<ID>.md`, `docs/…`, `GLOSSARY.md`. Nach der ersten Freigabe gesperrt. |
| Authentifizierung | HTTPS-Token oder SSH-Deploy-Key (ed25519, mit Schreibrecht eintragen). |
| Auto-Push | Push inkl. Version-Tags nach jeder Freigabe/Rücknahme; *Test connection* und *Push now* manuell. |

Tokens und Schlüssel liegen AES-256-GCM-verschlüsselt (`SECRET_KEY` oder Schlüsseldatei im Volume – für produktive Instanzen `SECRET_KEY` außerhalb des Daten-Volumes setzen) und werden nie wieder ausgegeben. Ein gespeichertes Token gilt nur für seinen Host. SSH-Host-Keys werden pro Team beim ersten Kontakt gelernt; nach einem echten Serverwechsel `POST /api/teams/<id>/git/forget-host-key`.

## Agenten anbinden (MCP)

Ein Zugang gehört zu **einem Team** und handelt mit den **aktuellen** Rechten der Person.

1. **OAuth 2.1** (empfohlen): `claude mcp add --transport http specs <PUBLIC_URL>/mcp` → anmelden, Team wählen, erlauben.
2. **Persönliches Token** (`spc_…`) unter *Account → Agent access*: Team, Scope (`mcp:read` / `mcp:drafts` / `mcp:write`), Ablauf. Nur einmal sichtbar, als Hash gespeichert.

**Lesen:** `get_team_context`, `list_specs`, `get_spec(id, version?)`, `list_documents`, `get_document`, `get_glossary`, `list_spec_types`, `get_work_list`, `get_spec_changes`, `list_decisions`, `list_reports`, `list_checks`.
**Schreiben** (`mcp:write`): `create_draft_spec`, `update_draft_spec`, `create_draft_document`, `update_draft_document`, `add_feedback`, `list_feedback`, `withdraw_feedback`, `request_decision`, `report_implementation`, `register_check`, `report_check_result`, `retire_check`, `derive_from_document` (siehe unten). Es gibt **kein** Freigabe-Tool: Agenten-Änderungen bleiben Entwurf (Chip *Agent draft*), `base_rev` verhindert Überschreiben, Foundation-Dokumente sind gesperrt, Limit 60 Schreibzugriffe/Stunde.

**Glossar und Specs aus Dokumenten ableiten:** Der MCP-Prompt `derive_glossary_and_specs` (Argument: Pfad oder Spec-ID) führt den Agenten durch den Ablauf: Quelle mit `get_document`/`get_spec` (`draft=true`) lesen, dann **ein** Aufruf von `derive_from_document` mit Begriffen (Definition, Aliase, *See also*) und/oder Spec-Entwürfen. Das Tool schreibt die Begriffe als Definitionsliste in den Entwurf `glossary/from-<Quelle>.md` (erneute Aufrufe mergen pro Begriff), überspringt Begriffe und Aliase, die schon definiert sind (freigegeben oder in einem anderen Entwurf), und meldet sie als `exists`. Jeder abgeleitete Spec bekommt einen Abschnitt `## SOURCE` und verlinkt den Glossar-Entwurf; der geht mit dem ersten freigegebenen Spec live. Ohne neuen Spec verlinkt `attach_to=<Spec-ID>` ihn. Nichts wird ohne Freigabe durch eine Person veröffentlicht.

## Agenten selbstständig arbeiten lassen

Menschen schreiben und geben frei, Agenten bauen und melden zurück.

1. Ein Approver gibt frei; der **Agent trigger** (Webhook) startet den Agenten, oder er läuft nach Zeitplan.
2. Der Agent holt `get_work_list` (Zustände `new`, `changed`, `in_progress`, `partial`, `blocked`, `recheck`) und baut.
3. Bei offenen Fragen ruft er `request_decision` auf (optional `blocking`) statt zu raten. Menschen antworten im **Garden** – auch offline; danach löst der Trigger erneut aus.
4. Am Ende `report_implementation`: Status, jedes Akzeptanzkriterium (`met` / `deviating` / `open`), Belege, Abweichungen. Ein neuer Release macht den Bericht „Outdated“.
5. **Checks** machen Belege wiederholbar: pro Kriterium ein registrierter Check (`test`, `ci`, `command`, `metric`, `url`, `manual`), die App zeigt *Verified*, *Check failing*, *Check stale* oder *Claimed only*. Veraltete oder fehlgeschlagene Checks setzen den Spec wieder in die Arbeitsliste. Eine Pipeline kann Ergebnisse selbst melden: `POST /api/ci/checks/results` mit Token-Scope *Read & write drafts* (max. 50 pro Aufruf, `source: ci`). Die App führt nichts selbst aus.
6. **Feedback:** Agenten widersprechen oder fragen nach, ohne den Spec zu ändern (`add_feedback`: concern, conflict, question, suggestion, gap). Editor+ können annehmen, ablehnen, antworten oder per *Accept & add to spec* als Punkt unter `## REVIEW NOTES` übernehmen. Approver und Admins bekommen einen Mail-Digest (`FEEDBACK_MAIL_DEBOUNCE_MS`, abschaltbar).

**Garden** zeigt, was auf dich wartet (Entscheidungen, Feedback), den Umsetzungsstand jedes freigegebenen Specs und *Team health*; Team-Admins können Agenten pausieren.

**Agent trigger** (*Members & Git → Agent trigger*, Team-Admin): Adresse, optional Token (`Authorization: Bearer …`) und Header, Ereignisse (Freigabe, Antwort), Format `text` oder `full`. Aufrufe werden entprellt (`HOOK_DEBOUNCE_MS`, 5 s); mit Token kommen `X-Specs-Timestamp` und `X-Specs-Signature: sha256=<HMAC-SHA256(Token, "<Timestamp>.<Body>")>` mit. Lokale/private Ziele sind gesperrt (`HOOK_ALLOW_LOCAL=1` erlaubt sie). Der Webhook ist nur der Anstoß – maßgeblich ist die Arbeitsliste.

**Claude Code als Routine in der Cloud** (Stand November 2026, Research Preview):

1. Server aus dem Internet erreichbar machen (siehe *HTTPS* → `scripts/go-public.sh`).
2. Token mit Scope **Read & write drafts** anlegen.
3. Im Ziel-Repository eine `.mcp.json` committen (fertig unter *Members & Git → Agent setup*):
   ```json
   { "mcpServers": { "specs": { "type": "http", "url": "<PUBLIC_URL>/mcp", "headers": { "Authorization": "Bearer ${SPECS_TOKEN}" } } } }
   ```
   `SPECS_TOKEN` in der Routine-Umgebung setzen und ggf. die Domain erlauben. Alternativ als Custom Connector in claude.ai (OAuth).
4. Unter <https://claude.ai/code/routines> eine Routine für das Repository anlegen; als Anweisung *Agent setup → Copy prompt* einfügen. Dort einen API-Trigger erzeugen, in Specs unter *Agent trigger* **Fill in for a Claude Code routine** wählen, Fire-URL und Token eintragen, *Send test*. Zusätzlich empfiehlt sich ein stündlicher Zeitplan-Trigger.

Lokal ohne Tunnel: `claude mcp add --transport http specs http://localhost:3000/mcp --header "Authorization: Bearer spc_…"`.

## HTTPS und PUBLIC_URL

Service Worker (Offline-Start, Installation am Handy) brauchen HTTPS (Ausnahme `localhost`). Hinter einem TLS-Reverse-Proxy setzen:

```
PUBLIC_URL=https://specs.example.org   # genau die Adresse, die der Browser sieht (auch für MCP/OAuth)
TRUST_PROXY=1                          # genau ein Proxy davor (nie „allen vertrauen“)
```

Der Proxy muss `Host`, `X-Forwarded-For` und `X-Forwarded-Proto` weiterreichen. Auf einer Debian-Installation: `garten url https://specs.example.org`.

```caddy
specs.example.org {
	reverse_proxy 192.168.10.47:3000
}
```

**Von unterwegs erreichbar ohne Portfreigabe:** `scripts/go-public.sh` startet einen Cloudflare-Tunnel (Compose-Profil `public`), setzt `PUBLIC_URL` und `TRUST_PROXY=1` in `.env`; `prepare` prüft nur, `status` zeigt die Adresse, `stop` schließt den Tunnel. Das Skript weigert sich, solange `admin@localhost` das Demo-Passwort hat. Ein Quick Tunnel (`*.trycloudflare.com`) wechselt bei jedem Neustart die Adresse; für eine feste Adresse `TUNNEL_TOKEN` und `PUBLIC_URL` in `.env` eintragen. Mit `https://` in `PUBLIC_URL` sind Cookies `Secure` – dann auch am Rechner die öffentliche Adresse benutzen.

## Sicherheit im Betrieb

* **Passwörter:** mindestens 10 Zeichen, scrypt; Anmeldeversuche pro IP, Konto und IP+Konto gedrosselt (10 in 5 Min.); Sitzungen enden nach `SESSION_IDLE_DAYS` (14). Keine 2FA.
* **SSO (OIDC):** `state` und Nonce gebunden, ID-Token geprüft; E-Mail muss bestätigt sein (`OIDC_TRUST_UNVERIFIED_EMAIL=1` hebt das auf). Bestehende Passwort-Konten, Admins und verknüpfte Konten werden nicht automatisch verknüpft.
* **Header:** CSP (nur eigene Skripte), `frame-ancestors 'none'`, `nosniff`, COOP, Permissions-Policy; bei `https://` auch HSTS und Cookie-Präfix `__Host-`.
* **Audit-Log:** Anmeldungen, Rollen, Tokens, Freigaben, Git-/Webhook-Einstellungen, Verwaltung – `GET /api/admin/audit`, Aufbewahrung `AUDIT_RETENTION_DAYS` (180). Geheimnisse werden nie protokolliert.
* Der MCP-Server weist Agenten an, Inhalte von Specs und Feedback als Daten zu behandeln, nicht als Anweisungen.

## Entwicklung und Tests

```bash
npm run build                # Frontend bauen (web/dist)
cd web && npm run dev        # Vite-Dev-Server mit Proxy auf :3000 (Server separat: npm start)
npm test                     # baut das Frontend und führt alle Tests aus
npm run ux-audit             # Barrierefreiheit/Performance auf Handy und Desktop (axe-core, WCAG 2.2 AA)
```

Einzelne Suiten: `tests/api.test.mjs`, `tests/oidc.test.mjs`, `tests/unit.test.mjs`, `web` (Vitest), `web/e2e/ui.test.mjs` (Playwright). Weitere Dokumente: `docs/DESIGN-SYSTEM.md`, `docs/UI-VOCABULARY.md`, `docs/UX-SCORECARD.md`, `web/PARITY.md`.

Stack: React 19 + TypeScript (Vite, PWA) in `web/`, Node 24 + Express + `node:sqlite` + `git` im Server, gemeinsamer Code in `shared/`. Offline-first über Service Worker und IndexedDB; Sync per `POST /api/teams/:id/sync` mit Konflikterkennung pro Item.

## Bekannte Lücken

* Der Agenten-Kreislauf ist gegen einen lokalen Claude-Code-Lauf und einen nachgestellten Routine-Endpunkt getestet, nicht gegen eine echte Cloud-Routine. Der Tunnel-Start in `go-public.sh` ist ungetestet.
* Git-Remote-Zugriff ist nur gegen ein lokales Bare-Repo getestet, nicht gegen GitHub/GitLab. Die frei wählbare Remote-URL ist eine SSRF-Fläche (ggf. per Egress-Firewall begrenzen).
* Leitplanken und Checks werden nicht maschinell durchgesetzt. Beantworten zwei Menschen dieselbe Entscheidung, gewinnt die später eintreffende Antwort ohne Konflikt-Dialog.
* Drag & Drop und Mobil/Touch sind nicht auf echten Geräten getestet.
* Rechte gelten pro Team, nicht pro Spec; der Team-Schlüssel ist nicht änderbar. Nur OIDC als SSO, keine 2FA, nur Einladungs- und Digest-Mails, Konfliktlösung nur auf Dokumentebene, Diagramme nur Mermaid.
* Der Markdown-Round-Trip verliert Info-Strings hinter der Code-Sprache; nummerierte Listen werden als Aufzählung gespeichert.
