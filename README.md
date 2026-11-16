# Garten (Specs)

Self-hosted, offline-first App, um auf Handy und Desktop Spezifikationen und Dokumente für KI-Agenten zu schreiben – **pro Team**.
Freigegebene (approved) Specs werden als Markdown in das Git-Repo des Teams geschrieben (Commit + Tag pro Version, Autor = Freigebender),
optional in dessen Entwicklungs-Repository gepusht und über einen **MCP-Server** an Agenten ausgeliefert. Entwürfe bleiben privat.

## Installation

**Docker**

```bash
ADMIN_PASSWORD='mein-passwort' docker compose up -d   # ohne ADMIN_PASSWORD: wird erzeugt und im Log angezeigt
docker compose logs specs
```

<http://localhost:3000> → `admin@localhost`. `SEED_DEMO=1` (Default) füllt das erste Team mit Beispieldaten. Konfiguration per Umgebungsvariablen, siehe `docker-compose.yml`.

Compose startet das veröffentlichte Image `ghcr.io/kogoro/garten:latest` (amd64 und arm64). Aktualisieren: `docker compose pull && docker compose up -d`. Eine feste Version: `GARTEN_IMAGE=ghcr.io/kogoro/garten:0.12.0`. Selbst bauen aus dem Checkout: `GARTEN_IMAGE=garten:local docker compose up -d --build`.

**Debian 12/13 / Ubuntu 24.04 (VM, Server, LXC), als root:**

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kogoro/Garten/main/scripts/install-debian.sh)"
```

Installiert den **neuesten Release** nach `/opt/garten`, Daten unter `/var/lib/garten/data`, Einstellungen in `/etc/garten/garten.env` (dieselben Variablen wie in `docker-compose.yml`), Dienst `garten` auf `http://<IP>:3000`. Zugangsdaten stehen in `/root/garten.creds`. Der Installer lädt das fertig gebaute Release-Archiv (`garten-<tag>.tar.gz`, geprüft gegen die `.sha256`-Datei) und installiert nur noch die Server-Abhängigkeiten – kein Frontend-Build auf dem Server. Gibt es kein Archiv (Branch, ältere Releases), baut er wie bisher aus dem Quellcode (einige Minuten, rund 1 GB RAM).

| Befehl                                |                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `garten update`                       | auf den neuesten Release aktualisieren (Daten und Einstellungen bleiben) |
| `garten info` · `garten logs`         | Adresse, Version, Status · Log                                           |
| `garten backup`                       | Archiv in `/root`, im laufenden Betrieb                                  |
| `garten url https://spec.example.org` | eigene Adresse (Reverse-Proxy mit HTTPS)                                 |

`GARTEN_REF=v0.11.0 garten update` installiert eine bestimmte Version, `GARTEN_REF=main` den Entwicklungsstand (immer aus dem Quellcode gebaut).

**Update:** Die neue Version wird in `/opt/garten.new` vorbereitet, während die alte weiterläuft. Erst wenn sie vollständig ist, wird der Dienst gestoppt und das Verzeichnis getauscht; die vorige Version bleibt als `/opt/garten.old`. Antwortet die neue Version nicht auf `/healthz`, kommt automatisch die vorige zurück. Schlägt Download oder Build fehl, läuft die alte Version einfach weiter. Die Datenbank von unmittelbar vor dem Update liegt in `/var/lib/garten/pre-update.db`.

**Backup und Wiederherstellung:** `garten backup` stoppt den Server nicht. Es schreibt einen konsistenten Schnappschuss der SQLite-Datenbank (`VACUUM INTO`), dazu den Rest von `data/` (Git-Repos der Teams unter `data/repos`, `secret.key`, `known_hosts`) und `garten.env` nach `/root/garten-backup-<Zeit>.tar.gz`. Wiederherstellen:

```bash
systemctl stop garten
rm -rf /var/lib/garten/data                        # auch alte specs.db-wal/-shm, die nicht zum Schnappschuss passen
tar xzf /root/garten-backup-<Zeit>.tar.gz -C /var/lib/garten data
chown -R garten:garten /var/lib/garten/data
systemctl start garten
```

`garten.env` liegt ebenfalls im Archiv (`tar xzf … -C /etc/garten garten.env`), falls die Einstellungen verloren sind. Plain HTTP funktioniert nur online – Offline-Modus und Handy-Installation brauchen HTTPS (siehe unten). Nur per VPN erreichbar heißt: Cloud-Routinen von Claude Code erreichen den Server nicht.

## Releases

Version in `package.json` erhöhen, committen, dann Tag setzen und pushen:

```bash
git tag v0.12.0 && git push origin v0.12.0
```

Der Workflow `.github/workflows/release.yml` führt zuerst dieselben Prüfungen wie CI aus (Tests, Installer-Skript, Docker-Build, Audit) und prüft, dass der Tag zur `package.json`-Version passt. Erst dann veröffentlicht er:

- das Docker-Image `ghcr.io/kogoro/garten:<version>` für amd64 und arm64, bei regulären Releases zusätzlich `:latest`,
- den GitHub-Release mit automatisch erzeugten Notizen und dem fertig gebauten Archiv `garten-<tag>.tar.gz` samt `garten-<tag>.tar.gz.sha256` (Server, `shared/`, gebautes `web/dist`, `package.json`, `package-lock.json`, `scripts/`; ohne `node_modules`). Lokal erzeugt es `scripts/release-tarball.sh <tag>` nach einem `npm --prefix web run build`.

Tags mit `-`, z. B. `v0.12.0-rc.1`, sind Vorab-Releases: kein `:latest`, und `garten update` wählt sie nicht. Ohne veröffentlichten Release bricht `garten update` ab, statt auf `main` auszuweichen. Das Image-Paket ist nach dem ersten Release in GitHub einmalig auf _public_ zu stellen, damit `docker compose pull` ohne Anmeldung funktioniert.

## Teams, Einladungen, Rollen

- Jeder Nutzer kann ein **eigenes Team** anlegen (`MAX_TEAMS_PER_USER`, abschaltbar mit `ALLOW_TEAM_CREATION=0`) und wird dessen Team-Admin. Alle Daten (Specs, Dokumente, Glossar, Git-Repo, MCP-Zugriff) sind strikt an ein Team gebunden.
- **Einladung** durch den Team-Admin (_Members & Git → Invite people_): E-Mail + Rolle → einmaliger Link, 7 Tage gültig; mit SMTP wird er zusätzlich per Mail verschickt. Offene Einladungen lassen sich erneut senden (_Resend_, alter Link verfällt) und widerrufen.
- Der **Instanz-Admin** verwaltet nur Teams und Konten (Seite _Admin_), lädt aber niemanden ein. Der einzige Admin eines Teams kann nicht gelöscht werden.
- Login per E-Mail/Passwort oder optional OpenID Connect (`OIDC_*`).

| Recht                                                              | viewer | editor | approver | admin |
| ------------------------------------------------------------------ | :----: | :----: | :------: | :---: |
| Lesen                                                              |   ✓    |   ✓    |    ✓     |   ✓   |
| Entwürfe schreiben, löschen; Agent-Scopes `mcp:drafts`/`mcp:write` |        |   ✓    |    ✓     |   ✓   |
| Freigeben / zurückziehen / nach Git pushen                         |        |        |    ✓     |   ✓   |
| Mitglieder, Git-Verbindung, Team-Einstellungen                     |        |        |          |   ✓   |

**E-Mail (optional, nur Einladungen und Feedback-Digest):** `SMTP_URL` (`smtp://user:pass@host:587` STARTTLS oder `smtps://…:465`, Sonderzeichen URL-kodieren) und `SMTP_FROM`; `SMTP_REQUIRE_TLS=1` verweigert unverschlüsselten Versand. _Admin → E-mail_ schickt eine Testmail. Höchstens 30 Einladungen pro Team und Stunde.

## Specs, Dokumente, Glossar

- **Spec-Typen:** Feature, API, UI, Data model, NFR, Integration, dazu Architecture spec und ADR – jeweils mit Vorlage. Teams definieren eigene Typen (_Members & Git → Spec types_). Der Typ steht im Front-Matter (`type: api`) und ist per MCP filterbar.
- **Formular statt Editor:** Ein Typ kann seinen Inhalt als Formular mit Feldern, Listen und Tabs beschreiben (Feldtypen u. a. Requirements, API-Endpoints, Mermaid-Diagramm, Checkliste). Gespeichert wird immer Markdown (`## FELDNAME`); über das Overflow-Menü wechselt man zwischen **Form**, **Blocks** und **Markdown**. Unbekannte Abschnitte bleiben erhalten („Other content“).
- **Editor:** Blöcke auf Basis von BlockNote (Text, Überschriften, Requirement, Checkliste, Liste, Definition, Zitat, Code, Diagramm, API-Endpoint), `/` öffnet das Block-Menü, `@` verlinkt Dokumente, `#` Glossarbegriffe. Mermaid-Diagramme rendern auch offline (die Diagramm-Engines lädt die App nach dem ersten Start im Hintergrund nach, die Installation wartet nicht darauf); andere Textformate gehen als Code-Block an den Agenten.
- **Foundation-Dokumente:** Jedes Team hat `vision.md`, `strategy.md` und `guardrails.md`; weitere lassen sich anheften (auch jeder Glossarbegriff ist ein Foundation-Dokument). Sie gehören keinem Spec, gehen nach der letzten Änderung automatisch live (pro Team umstellbar auf „Publish now“) und landen unter `<Ordner>/docs/`. `get_team_context()` liefert sie Agenten in einem Aufruf.
- **Leitplanken:** Abschnitte _Always_ / _Never_ (`- G1: …`) in `guardrails.md` sind für Agenten verbindlich; würde eine Aufgabe eine Regel brechen, fragt der Agent per `request_decision`. Jeder Bericht hält fest, gegen welche Regeln gebaut wurde. Kommt eine Regel hinzu oder ändert sich ihr Wortlaut, steht ein umgesetzter Spec wieder in der Arbeitsliste (`guardrails_changed` mit `rules_changed`), der Garden zeigt ihn unter _Needs attention_, und der Agent-Trigger meldet die neuen Leitplanken als Freigabe. Gestrichene Regeln lösen nichts aus. Aus Feedback oder Abweichungen wird per **Make it a rule** eine Regel.
- **Aus Text ableiten:** Im Menü (⋯) eines Specs oder Dokuments gibt es _New spec from selection / this document…_ und _Glossary term from selection / this document…_. Ohne Markierung gilt das ganze Dokument. Beim Spec wählt man Typ und Titel; der Text wird kopiert und bekommt einen Abschnitt `## SOURCE`. Beim Begriff öffnet sich der Glossar-Dialog vorbefüllt (kurze Markierung = Begriff, längere = Definition, ganzes Dokument = Titel und erster Absatz). Enthält ein Dokument schon Definitionen, übernimmt _Add N definitions … to the glossary_ sie auf einmal. Das Original bleibt unverändert; Agenten tun dasselbe über `derive_from_document`.
- **Dokumente in Ordnern:** IDs sind Pfade (bis 5 Ebenen), Ordner sind eigene Objekte, Verschieben/Umbenennen zieht Verlinkungen nach.
- **Glossar als Ordner:** Jeder Begriff ist eine eigene Markdown-Datei `docs/glossary/<Ordner>/<begriff>.md`; Unterordner gruppieren Begriffe (verschachtelbar). Die Datei beginnt mit Front Matter (`term`, `aliases`, `avoid` = Wörter, die man nicht verwenden soll, `distinct` = nicht verwechseln mit, `see`, bei Importen `source`); danach steht die Definition als normales Markdown (Absätze, Listen, Code, Beispiele). Verweise: `[[Begriff]]` in Definitionen, `#[Begriff]` im Fließtext (im Editor ein Chip mit der Definition beim Hover). Ändern sich Begriffe, geht das debounced in **einem** Commit pro Team live; ein Umbenennen kann alle Verweise mitziehen und den alten Namen als Synonym behalten. Die Seite _Glossary_ hat drei Tabs: **Terms** (Ordnerbaum, Definition, _Used in_, _History_ = Git-Log der Datei), **Proposed** (von Agenten vorgeschlagene Begriffe in `glossary/_proposed/`, gehen nie live; nur Approver nehmen sie an oder lehnen ab) und **Health** (zwei Definitionen, kaputte Verweise, zu vermeidende Wörter in Specs, doppelte Synonyme, Updates aus dem globalen Glossar, unbenutzte Begriffe). Verwendet ein Spec ein Wort aus `avoid`, zeigt der Editor einen Vorschlag; beim Approve, beim _Done_ auf dem Handy und beim Verlassen eines bearbeiteten Specs warnt ein Dialog bzw. Hinweis mit _Replace_. Export und Import als **ZIP** (eine Datei pro Begriff) oder **CSV**. Definition-Blöcke in Specs und Dokumenten (`Term` / `: Definition`) zählen weiter mit und erscheinen unter _In specs & documents_. `GLOSSARY.md` / `get_glossary` fassen alles zusammen. _Search definitions online_ (Wikipedia, Wiktionary, dictionaryapi.dev) schickt nur den Suchbegriff, `LOOKUP=0` schaltet das ab. Instanz-Admins pflegen ein **globales Glossar** (_Admin → Global glossary_, Import aus CSV/JSON/Markdown); Teams importieren Begriffe als editierbare Kopie, _Health_ bietet neue Revisionen mit Diff an. Definitionen sind überall formatierbar: der Dialog _New glossary term_ und das globale Glossar nutzen denselben Block-Editor wie die Begriffsseite (Absätze, Listen, Code, Tabellen), der Definition-Block in Specs nimmt Inline-Formatierung (fett, kursiv, Code, Links, `#[Begriff]`), und die Listen zeigen den ersten Absatz formatiert. Das globale Glossar wird als CSV exportiert, damit mehrzeilige Definitionen erhalten bleiben.
- **Umstieg von `glossary.md`:** Beim ersten Start nach dem Update wird das alte `glossary.md` aufgeteilt: jede Definition wird eine Datei, `##`-Überschriften werden Ordner, `###` Unterordner; war das Glossar live, geht der neue Ordner in einem Commit live und `glossary.md` verschwindet aus dem Repository. Unveröffentlichte Agenten-Entwürfe `glossary/from-*.md` werden zu Vorschlägen.

## Git-Verbindung pro Team

_Team → Git connection_ (Team-Admin). Jedes Team hat ein eigenes Repo (`/data/repos/<team>`) und optional einen Remote, typischerweise das Entwicklungsprojekt.

| Einstellung       | Bedeutung                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL               | `https://…` oder SSH. `http://` nur mit `GIT_ALLOW_HTTP=1`, private/lokale Adressen nur mit `GIT_ALLOW_PRIVATE=1`; `file://`, `ext::` u. Ä. werden abgelehnt. |
| Branch            | Ziel-Branch; vorhandene Commits werden zuerst gemergt (bei Konflikten gewinnt Specs).                                                                         |
| Ordner            | Specs schreibt nur in `<Ordner>/` (Default `specs/`): `<ID>.md`, `docs/…`, `GLOSSARY.md`. Nach der ersten Freigabe gesperrt.                                  |
| Authentifizierung | HTTPS-Token oder SSH-Deploy-Key (ed25519, mit Schreibrecht eintragen).                                                                                        |
| Auto-Push         | Push inkl. Version-Tags nach jeder Freigabe/Rücknahme; _Test connection_ und _Push now_ manuell.                                                              |

Tokens und Schlüssel liegen AES-256-GCM-verschlüsselt (`SECRET_KEY` oder Schlüsseldatei im Volume – für produktive Instanzen `SECRET_KEY` außerhalb des Daten-Volumes setzen) und werden nie wieder ausgegeben. Ein gespeichertes Token gilt nur für seinen Host. SSH-Host-Keys werden pro Team beim ersten Kontakt gelernt; nach einem echten Serverwechsel `POST /api/teams/<id>/git/forget-host-key`.

## Agenten anbinden (MCP)

Ein Zugang gehört zu **einem Team** und handelt mit den **aktuellen** Rechten der Person.

1. **OAuth 2.1** (empfohlen): `claude mcp add --transport http specs <PUBLIC_URL>/mcp` → anmelden, Team wählen, erlauben.
2. **Persönliches Token** (`spc_…`) unter _Account → Agent access_: Team, Scope (`mcp:read` / `mcp:drafts` / `mcp:write`), Ablauf. Nur einmal sichtbar, als Hash gespeichert.

**Lesen:** `get_team_context`, `list_specs`, `get_spec(id, version?)`, `get_criteria(spec_id, version?)`, `list_documents`, `get_document`, `get_glossary(term?, spec?)` (volle Definitionen, `avoid`, `not_to_be_confused_with`, Ordner; mit `spec` nur die Begriffe, die der Spec verwendet), `list_spec_types`, `get_work_list`, `get_spec_changes`, `list_decisions`, `list_reports`, `list_checks`.
**Schreiben** (`mcp:write`): `create_draft_spec`, `update_draft_spec`, `create_draft_document`, `update_draft_document`, `add_feedback`, `list_feedback`, `withdraw_feedback`, `request_decision`, `report_implementation`, `register_check`, `report_check_result`, `retire_check`, `propose_term`, `derive_from_document` (siehe unten). Es gibt **kein** Freigabe-Tool: Agenten-Änderungen bleiben Entwurf (Chip _Agent draft_), `base_rev` verhindert Überschreiben, Foundation-Dokumente sind gesperrt, Limit 60 Schreibzugriffe/Stunde (Lesen, z. B. `list_feedback`, zählt nicht; Checks haben ein eigenes Limit von 300/Stunde).

**Glossar und Specs aus Dokumenten ableiten:** Der MCP-Prompt `derive_glossary_and_specs` (Argument: Pfad oder Spec-ID) führt den Agenten durch den Ablauf: Quelle mit `get_document`/`get_spec` (`draft=true`) lesen, dann **ein** Aufruf von `derive_from_document` mit Begriffen (Definition, Aliase, _See also_) und/oder Spec-Entwürfen. Das Tool legt jeden Begriff als Vorschlag `glossary/_proposed/<begriff>.md` an (erneute Aufrufe aktualisieren denselben Vorschlag), überspringt Begriffe und Aliase, die schon definiert oder vorgeschlagen sind, und meldet sie als `exists`. Einzelne Begriffe schlägt `propose_term` vor. Jeder abgeleitete Spec bekommt einen Abschnitt `## SOURCE`. Nichts wird ohne Freigabe durch eine Person veröffentlicht.

## Agenten selbstständig arbeiten lassen

Menschen schreiben und geben frei, Agenten bauen und melden zurück.

1. Ein Approver gibt frei; der **Agent trigger** (Webhook) startet den Agenten, oder er läuft nach Zeitplan.
2. Der Agent holt `get_work_list` (Zustände `new`, `changed`, `in_progress`, `partial`, `blocked`, `recheck`) und baut.
   Vorher reserviert er den Spec mit `claim_spec` (eine Frist von 30 Minuten, höchstens 240), die er während der Arbeit erneuert (Heartbeat). Specs, die ein anderer Agent reserviert hat, stehen in der Arbeitsliste getrennt unter `claimed_by_others`, ein zweiter `claim_spec` wird abgelehnt. `report_implementation` gibt die Reservierung zurück (bei `in_progress` verlängert es sie), `unclaim_spec` ohne Bericht. Läuft eine Reservierung ab, ist der Spec wieder frei.
3. Bei offenen Fragen ruft er `request_decision` auf (optional `blocking`) statt zu raten. Menschen antworten im **Garden** – auch offline; danach löst der Trigger erneut aus. Eine Antwort oder Ablehnung (_Dismiss_) setzt den Spec als `decision_answered` an den Anfang der Arbeitsliste, auch wenn er zuvor `blocked` war. Beim Antworten schreibt _Also write it into the spec_ (voreingestellt) die Entscheidung als `- Frage → Antwort – Notiz (Wer, Datum)` unter `## DECISIONS` in den Entwurf des Specs; mit der nächsten Freigabe steht sie im Spec, und Agenten fragen nicht erneut. Bereits beantwortete Entscheidungen haben dafür _Add to spec_; eine geänderte Antwort ersetzt die Zeile.
4. Am Ende `report_implementation`: Status, jedes Kriterium (`met` / `deviating` / `open`), Belege, Abweichungen. Ein neuer Release macht den Bericht „Outdated“.
   Die Checkliste kommt vom Server: `get_criteria` liest aus der freigegebenen Version jede Anforderung (`R1 …`, ID aus dem Spec) und jeden Listenpunkt unter einer Überschrift mit _Acceptance_/_Criteria_/_Definition of done_ (`AC1`, `AC2` … in Reihenfolge). Der Bericht nennt sie per ID oder Zitat; fehlende werden als `open` („Not in the report“) gespeichert, `implemented` wird abgelehnt, solange eines fehlt. Kriterien, die der Spec nicht kennt, bleiben als zusätzliche Zeilen erhalten.
5. **Checks** machen Belege wiederholbar: pro Kriterium ein registrierter Check (`test`, `ci`, `command`, `metric`, `url`, `manual`), die App zeigt _Verified_, _Check failing_, _Check stale_ oder _Claimed only_. Veraltete oder fehlgeschlagene Checks setzen den Spec wieder in die Arbeitsliste. Eine Pipeline kann Ergebnisse selbst melden: `POST /api/ci/checks/results` mit Token-Scope _Read & write drafts_ (max. 50 pro Aufruf, `source: ci`, optional `spec_version` = die Version, die der getestete Stand umsetzt; ältere Versionen zählen als veraltet). Was zu laufen hat, liefert `GET /api/ci/checks` (jedes Team-Token, Filter `?state=failing,stale,unverified`, `?spec=`). _Agent setup → 4_ enthält einen GitHub-Actions-Workflow dafür; die Befehle stehen im Repository, die Pipeline führt nie einen Befehl aus, den sie vom Server bekommt. Mit _Only CI results prove a check_ (Team-Admin) zählt ein „pass“ des Agenten nicht mehr als Beleg (`needs_ci`). Die App führt nichts selbst aus.
6. **Feedback:** Agenten widersprechen oder fragen nach, ohne den Spec zu ändern (`add_feedback`: concern, conflict, question, suggestion, gap). Editor+ können annehmen, ablehnen, antworten oder per _Accept & add to spec_ als Punkt unter `## REVIEW NOTES` übernehmen. Approver und Admins bekommen einen Mail-Digest (`FEEDBACK_MAIL_DEBOUNCE_MS`, abschaltbar).

**Steuern pro Spec** (Approver und Admins, im Bericht eines Specs unter _Steering_): Priorität _High_ / _Normal_ / _Low_ ordnet die Arbeitsliste vor dem Zustand; _On hold_ (mit Begründung) nimmt einen Spec heraus (`on_hold`); _Build after_ nennt Specs, die vorher umgesetzt sein müssen – bis dahin steht er unter `waiting_on_specs`. Zyklen und unbekannte Specs werden abgelehnt. Die Pipeline zeigt das als Chips.

**Garden** zeigt, was auf dich wartet (Entscheidungen, Feedback), den Umsetzungsstand jedes freigegebenen Specs und _Team health_. _Spec quality by type_ (aufklappbar, aus `GET /api/teams/<id>/metrics` → `quality`) zeigt pro Spec-Typ Fragen und Feedback pro Spec, Anteil mit Abweichungen, Berichte pro Spec und die Zeit von Freigabe bis „implemented“ – viele Fragen heißen: Vorlage oder Akzeptanzkriterien des Typs schärfen; darunter die fünf Specs, mit denen Agenten am meisten kämpften; Team-Admins können Agenten pausieren.
Die Agenten-Liste beruht auf dem, was der Server sieht: letzter MCP-Aufruf jedes Zugangs (_Connected_ bis 15 Minuten danach), was er gerade reserviert hat (_Building_), und wann sein persönliches Token abläuft (Hinweis 7 Tage vorher). Ein Spec „In progress“ ohne Reservierung und ohne Bericht seit 2 Stunden landet unter _Needs attention_. Hat der Agent-Trigger angeschlagen, aber seit 15 Minuten kein Agent verbunden, zeigt der Garden _No agent came after the trigger_.

**Agent trigger** (_Members & Git → Agent trigger_, Team-Admin): Adresse, optional Token (`Authorization: Bearer …`) und Header, Ereignisse (Freigabe, Antwort, Check – ein von CI gemeldeter Fehlschlag oder ein veralteter Check, einmal pro Lauf –, Fortsetzen nach einer Pause), Format `text` oder `full`. Aufrufe werden entprellt (`HOOK_DEBOUNCE_MS`, 5 s); mit Token kommen `X-Specs-Timestamp` und `X-Specs-Signature: sha256=<HMAC-SHA256(Token, "<Timestamp>.<Body>")>` mit. Lokale/private Ziele sind gesperrt (`HOOK_ALLOW_LOCAL=1` erlaubt sie). Der Webhook ist nur der Anstoß – maßgeblich ist die Arbeitsliste.

**Claude Code als Routine in der Cloud** (Stand November 2026, Research Preview):

1. Server aus dem Internet erreichbar machen (siehe _HTTPS_ → `scripts/go-public.sh`).
2. Token mit Scope **Read & write drafts** anlegen.
3. Im Ziel-Repository eine `.mcp.json` committen (fertig unter _Members & Git → Agent setup_):
   ```json
   { "mcpServers": { "specs": { "type": "http", "url": "<PUBLIC_URL>/mcp", "headers": { "Authorization": "Bearer ${SPECS_TOKEN}" } } } }
   ```
   `SPECS_TOKEN` in der Routine-Umgebung setzen und ggf. die Domain erlauben. Alternativ als Custom Connector in claude.ai (OAuth).
4. Unter <https://claude.ai/code/routines> eine Routine für das Repository anlegen; als Anweisung _Agent setup → Copy prompt_ einfügen. Dort einen API-Trigger erzeugen, in Specs unter _Agent trigger_ **Fill in for a Claude Code routine** wählen, Fire-URL und Token eintragen, _Send test_. Zusätzlich empfiehlt sich ein stündlicher Zeitplan-Trigger.

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

- **Passwörter:** mindestens 10 Zeichen, scrypt; Anmeldeversuche pro IP, Konto und IP+Konto gedrosselt (10 in 5 Min.); Sitzungen enden nach `SESSION_IDLE_DAYS` (14). Keine 2FA.
- **SSO (OIDC):** `state` und Nonce gebunden, ID-Token geprüft; E-Mail muss bestätigt sein (`OIDC_TRUST_UNVERIFIED_EMAIL=1` hebt das auf). Bestehende Passwort-Konten, Admins und verknüpfte Konten werden nicht automatisch verknüpft.
- **Header:** CSP (nur eigene Skripte), `frame-ancestors 'none'`, `nosniff`, COOP, Permissions-Policy; bei `https://` auch HSTS und Cookie-Präfix `__Host-`.
- **Audit-Log:** Anmeldungen, Rollen, Tokens, Freigaben, Git-/Webhook-Einstellungen, Verwaltung – `GET /api/admin/audit`, Aufbewahrung `AUDIT_RETENTION_DAYS` (180). Geheimnisse werden nie protokolliert.
- Der MCP-Server weist Agenten an, Inhalte von Specs und Feedback als Daten zu behandeln, nicht als Anweisungen.

## Entwicklung und Tests

```bash
npm run build                # Frontend bauen (web/dist)
cd web && npm run dev        # Vite-Dev-Server mit Proxy auf :3000 (Server separat: npm start)
npm test                     # baut das Frontend und führt alle Tests aus
npm run ux-audit             # Barrierefreiheit/Performance auf Handy und Desktop (axe-core, WCAG 2.2 AA)
npm run lint                 # ESLint (server, shared, tests, scripts, web/src)
npm run typecheck            # TypeScript-Prüfung von server/ + shared/ (JSDoc, tsconfig.json) und web/
npm run format               # Prettier schreibt die Formatierung; format:check prüft nur
npm run check                # lint + typecheck + format:check – vor jedem Push
```

Vorher `npm ci` und `npm --prefix web ci` (Lint und Typprüfung von `web/src` brauchen die Web-Abhängigkeiten). `lint`, `typecheck` und `format:check` laufen in der CI. Der Code ist einmalig mit Prettier formatiert worden; dieser Commit steht in `.git-blame-ignore-revs` (`git config blame.ignoreRevsFile .git-blame-ignore-revs`), `.editorconfig` hält Editoren ohne Prettier auf derselben Linie. ESLint prüft nur auf Fehler (ungenutzte Variablen, unbekannte Namen, unbehandelte Promises, Hook-Regeln …), die Formatierung übernimmt Prettier (`.prettierrc.json`, Zeilenbreite 140). Der Server wird ohne Build per `checkJs` geprüft; Typen stehen als JSDoc im Code, Ergänzungen für Express und `node:sqlite` in `server/types.d.ts`. `tsconfig.json` nennt die noch abgeschalteten strikten Prüfungen mit ihrer aktuellen Fehlerzahl.

Einzelne Suiten: `tests/api/*.test.mjs` (eine Datei je Bereich), `tests/oidc.test.mjs`, `tests/unit.test.mjs` (alle mit `node --test`), `web` (Vitest), `web/e2e/ui.test.mjs` (Playwright). Weitere Dokumente: `docs/DESIGN-SYSTEM.md`, `docs/UI-VOCABULARY.md`, `docs/UX-SCORECARD.md`, `web/PARITY.md`.

Stack: React 19 + TypeScript (Vite, PWA) in `web/`, Node 24 + Express + `node:sqlite` + `git` im Server, gemeinsamer Code in `shared/`. Offline-first über Service Worker und IndexedDB; Sync per `POST /api/teams/:id/sync` mit Konflikterkennung pro Item.

## Bekannte Lücken

- Der Agenten-Kreislauf ist gegen einen lokalen Claude-Code-Lauf und einen nachgestellten Routine-Endpunkt getestet, nicht gegen eine echte Cloud-Routine. Der Tunnel-Start in `go-public.sh` ist ungetestet.
- Git-Remote-Zugriff ist nur gegen ein lokales Bare-Repo getestet, nicht gegen GitHub/GitLab. Die frei wählbare Remote-URL ist eine SSRF-Fläche (ggf. per Egress-Firewall begrenzen).
- Leitplanken und Checks werden nicht maschinell durchgesetzt. Beantworten zwei Menschen dieselbe Entscheidung, gewinnt die später eintreffende Antwort ohne Konflikt-Dialog.
- Drag & Drop und Mobil/Touch sind nicht auf echten Geräten getestet.
- Rechte gelten pro Team, nicht pro Spec; der Team-Schlüssel ist nicht änderbar. Nur OIDC als SSO, keine 2FA, nur Einladungs- und Digest-Mails, Konfliktlösung nur auf Dokumentebene, Diagramme nur Mermaid.
- Der Markdown-Round-Trip verliert Info-Strings hinter der Code-Sprache; nummerierte Listen werden als Aufzählung gespeichert.
