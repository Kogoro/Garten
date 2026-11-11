# Specs – Prototyp v0.10 (React)

Self-hosted, offline-first App, um auf Handy **und Desktop** Spezifikationen und Dokumente für KI-Agenten zu schreiben – **pro Team**.
Freigegebene (approved) Specs werden als Markdown in das Git-Repo **des Teams** geschrieben (Commit + Tag pro Version, Autor = Freigebender),
optional automatisch in dessen Entwicklungs-Repository gepusht und über einen **MCP-Server** an Agenten ausgeliefert. Entwürfe bleiben privat.

## Start

```bash
ADMIN_PASSWORD='mein-passwort' docker compose up -d --build   # ohne ADMIN_PASSWORD: wird erzeugt und im Log angezeigt
docker compose logs specs
```

<http://localhost:3000> → `admin@localhost` anmelden. `SEED_DEMO=1` (Default) füllt das erste Team mit Beispieldaten.
Konfiguration per Umgebungsvariablen, siehe `docker-compose.yml`.
**v0.3 ändert das Datenbankschema** (Teams). Ein Volume aus v0.2 wird mit klarer Fehlermeldung abgelehnt: `docker compose down -v` oder erst das Repo sichern.

## Teams, Einladungen, Rollen

* **Jeder Nutzer kann ein eigenes Team anlegen** (Workspace-Menü → *Create a new team*; max. `MAX_TEAMS_PER_USER`, abschaltbar mit `ALLOW_TEAM_CREATION=0`) und wird dessen Team-Admin. Der Team-Schlüssel (Präfix der Spec-IDs) wird aus dem Namen abgeleitet.
* **Mitglieder werden vom Team-Admin eingeladen** (*Members & Git → Invite people*): E-Mail + Rolle → einmaliger Link (7 Tage gültig). Neue Personen legen über den Link ihr Konto an; wer schon ein Konto hat, sieht die Einladung nach dem Login (Annehmen/Ablehnen) – oder per SSO, sobald die E-Mail eingeladen ist. Einladungen lassen sich widerrufen. Mit konfiguriertem Mailserver (siehe unten) wird die Einladung **per E-Mail** verschickt; der Link wird trotzdem angezeigt, damit eine fehlgeschlagene Zustellung nichts blockiert. Ohne Mailserver kopiert der Admin den Link.
* **Der Instanz-Admin verwaltet nur Teams und Konten** (Seite *Admin*): Teams ansehen, umbenennen, löschen (mit Schlüssel-Bestätigung); Konten deaktivieren, löschen, zum Admin machen, Passwort zurücksetzen, Tokens einsehen/widerrufen. Er lädt niemanden ein – das tun die Team-Admins. Ein Nutzer, der einziger Team-Admin ist, kann nicht gelöscht werden.
* **Rollen gelten pro Team:**

| Recht | viewer | editor | approver | admin (Team) |
|---|:-:|:-:|:-:|:-:|
| Lesen | ✓ | ✓ | ✓ | ✓ |
| Entwürfe schreiben, löschen | | ✓ | ✓ | ✓ |
| Agent darf Entwürfe lesen (`mcp:drafts`) | | ✓ | ✓ | ✓ |
| Agent darf Entwürfe schreiben (`mcp:write`) | | ✓ | ✓ | ✓ |
| Freigeben / zurückziehen / nach Git pushen | | | ✓ | ✓ |
| Mitglieder einladen, Git-Verbindung, Team-Einstellungen | | | | ✓ |

Alle Daten (Specs, Dokumente, Glossar, Git-Repo, MCP-Zugriff) sind strikt an ein Team gebunden. Mitglieder können ein Team verlassen. Login per E-Mail/Passwort oder optional OpenID Connect (`OIDC_*`).

## E-Mail (SMTP)

Optional und nur für Einladungen. Setze `SMTP_URL` (`smtp://user:pass@host:587` für STARTTLS oder `smtps://user:pass@host:465` für implizites TLS) und `SMTP_FROM` (`Specs <no-reply@example.com>`); mit `SMTP_REQUIRE_TLS=1` verweigert der Server unverschlüsselten Versand. Passwörter mit Sonderzeichen URL-kodieren.

* Die Mail nennt Team, einladende Person, Rolle, den einmaligen Link und die Gültigkeit (Text + HTML, Namen werden HTML-escaped).
* Seite **Team → Invite people**: „Send invitation“, in der Liste offener Einladungen **Resend** (erzeugt einen neuen Link, der alte wird ungültig) und **Revoke**.
* Schlägt der Versand fehl, bleibt die Einladung bestehen: die Oberfläche zeigt den Grund (ohne Zugangsdaten) und den Link zum Kopieren.
* **Admin → E-mail** zeigt, ob SMTP konfiguriert ist, und schickt per **Send test e-mail** eine Testnachricht an dein eigenes Konto.
* Missbrauchsschutz: höchstens 30 Einladungen pro Team und Stunde.

## Spec-Typen

Jede Spec hat einen **Typ**, der ihre Startstruktur (Vorlage) bestimmt und Agenten sagt, was sie lesen. Eingebaut: **Feature spec**, **API spec**, **UI spec / design rule**, **Data model**, **Non-functional requirement**, **Integration** (jeweils mit Vorlage aus Überschriften, Code-/Mermaid-Blöcken).

* *New spec* öffnet die Typ-Auswahl; der Typ erscheint als Chip in Liste und Editor-Leiste, die Liste lässt sich nach Typ filtern, im ⋯-Menü ändert man ihn später (der Inhalt bleibt).
* **Eigene Typen pro Team:** *Members & Git → Spec types → New type* (Name, Beschreibung, Vorlage als Markdown, optional „Start from“ ein eingebauter Typ). Ein Typ, den noch Specs verwenden, lässt sich nicht löschen.
* **Git/MCP:** Die freigegebene Datei trägt `type: api` im Front-Matter; `list_specs` liefert `type` und `type_label` und filtert mit `list_specs(type: "api")`.
* Bestehende Specs sind „Feature spec“; die Spalte wird automatisch migriert.

## Spec als Formular

Ein Spec-Typ kann seinen Inhalt als **Formular** beschreiben statt als freien Editor: vordefinierte Felder, Listen und **Tabs**, ganz ohne Editor. Eingebaut sind **API** (Tabs *Overview / Endpoints / Contract / Quality*), **Architecture spec** (Tabs *Context / Design / Consequences*: Status, Kontext, Treiber, Entscheidung, Übersichtsdiagramm, Komponenten, Alternativen, Konsequenzen, Risiken, offene Fragen, Requirements), **ADR** (klassisches Entscheidungsprotokoll: Status, Deciders, Kontext, Treiber, Optionen, Entscheidung, Konsequenzen, Links), **UI spec** und **NFR** als Formular (öffnen direkt als Formular); *Feature*, *Data model* und *Integration* haben ein Formular zur Auswahl, öffnen aber im Editor. Im Overflow-Menü wechselst du jederzeit zwischen **Form**, **Blocks** und **Markdown** – es ist immer dieselbe Datei.

* **Feldtypen:** Einzeilig, Text, Auswahl, Liste, Checkliste, Requirements (R1, R2 …, fortlaufend), API-Endpoints (Karten mit Tabs Description / Request / Responses), Diagramm (Mermaid mit Vorschau), Code. In Listen: `Enter` neue Zeile, `Rücktaste` in leerer Zeile löscht sie, `Alt+↑/↓` verschiebt.
* **Gespeichert wird Markdown:** jedes Feld ist ein Abschnitt `## FELDNAME` (Liste = `- Punkt`, Checkliste = `- [x] …`, Requirements = `R1 …`, Endpoints = ` ```endpoint GET /pfad `-Fences). Agenten, Git und der Block-Editor sehen dieselbe Datei.
* **Nichts geht verloren:** Abschnitte, die das Formular nicht kennt (z. B. nach einem Typwechsel oder von einem Agenten geschrieben), und Text vor dem ersten Abschnitt bleiben erhalten und stehen unter „Other content“.
* **Eigene Formular-Typen:** Team-Admins definieren unter *Members & Git → Spec types* Felder (Name, Typ, Auswahl-Optionen, Hinweis, Tab), Tabs und ob Specs als Formular öffnen. „Start from“ übernimmt ein eingebautes Formular als Vorlage.
* **Für Agenten:** `list_spec_types` liefert je Typ die Abschnitte mit Art (`kind`), Optionen und Hinweisen – so schreiben Agenten Drafts, die im Formular sauber ankommen.

## Feedback des Agenten zu Specs

Agenten widersprechen oder fragen nach, **ohne den Spec zu ändern**: mit Scope `mcp:write` gibt es `add_feedback(spec_id, kind, text, section?, evidence?)` (`kind`: concern, conflict, question, suggestion, gap) und `list_feedback(spec_id?, status?)`. Gleiche offene Einträge (gleicher Abschnitt und Text) werden zusammengeführt, pro Spec sind höchstens 50 offen.

* **In der App:** Der Button *Feedback* in der Editor-Leiste (Badge mit der Zahl offener Einträge), ein Chip „N feedback“ in der Spec-Liste und ein Hinweis auf der Release-Seite. Das Feedback-Sheet zeigt Art, Abschnitt, Text, Beleg (`evidence`), Absender (Token/Client) und die Version, auf die es sich bezieht. Editor+ können **Accept / Dismiss / Reopen / Mark done** und antworten; auch Menschen können Feedback anlegen.
* **Der Agent sieht die Entscheidung:** `list_feedback` liefert Status und Antwort, so wiederholt er sich nicht. Mit `withdraw_feedback(id)` nimmt er eigenes, noch offenes Feedback zurück (nie das anderer, nie nach einer Entscheidung).
* **Accept & add to spec:** übernimmt den Befund als Checklisten-Punkt unter `## REVIEW NOTES` im Spec (eine ungeprüfte Änderung am Arbeitsstand, die du verfeinern kannst); „Accept“ allein ändert den Spec nicht.
* **E-Mail-Digest:** Bei neuem Feedback bekommen Approver und Admins des Teams (nicht der Absender) eine gesammelte Mail nach einer Ruhephase (`FEEDBACK_MAIL_DEBOUNCE_MS`, Standard 2 min), sofern `SMTP_URL` gesetzt ist. Team-Admins schalten das unter *Members & Git* ab. Zusätzlich zeigt die Seitenleiste die Zahl offener Einträge.
* **API:** `GET/POST /api/teams/:id/feedback`, `PATCH …/feedback/:fid` (Rechte: lesen = alle, anlegen/bearbeiten = editor+); die offenen Zähler kommen mit jedem Sync.

## Foundation-Dokumente: Vision, Strategie, Glossar

Jedes Team hat immer **`vision.md`, `strategy.md` und `glossary.md`** (werden mit dem Team angelegt, lassen sich nicht löschen). Beliebige weitere Dokumente lassen sich als Foundation-Dokument **anheften** (⋯-Menü → *Pin*).

* Sie gehören **keinem Spec** – kein Verlinken nötig. Sobald sie Inhalt haben (reine Überschriften zählen als leer), gehen sie nach der letzten Änderung **automatisch live** (Standard; einstellbar pro Team: dann „Publish now“ durch einen Approver) und landen im Repo unter `<Ordner>/docs/`.
* **MCP:** `get_team_context()` liefert Vision, Strategie, weitere angeheftete Dokumente und das Glossar in einem Aufruf; der Server weist Agenten per `instructions` darauf hin, es zuerst aufzurufen. Leere Teile werden weggelassen. `list_documents` markiert sie mit `always: true`.
* **Glossar:** wird aus allen **Definition**-Blöcken freigegebener Specs, Dokumente und der Foundation-Dokumente erzeugt (`GLOSSARY.md`, `get_glossary`) – abfragbar, sobald es nicht leer ist.

## Git-Verbindung pro Team

Seite **Team → Git connection** (Team-Admin). Jedes Team hat sein eigenes lokales Repo (`/data/repos/<team>`) und optional **einen eigenen Remote** – typischerweise das Entwicklungsprojekt, damit der Agent die Specs direkt im Repo findet.

| Einstellung | Bedeutung |
|---|---|
| URL | `https://…` oder SSH (`git@host:org/repo.git`). Andere Schemata (`file://`, `ext::`, `-…`) werden abgelehnt; `http://` nur mit `GIT_ALLOW_HTTP=1`. |
| Branch | Ziel-Branch. Existiert er schon mit Commits, werden sie zuerst gemergt (bei Konflikten in Dateien, die Specs verwaltet, gewinnt Specs). |
| Ordner | Specs schreibt **nur** in `<Ordner>/` (Default `specs/`): `<ID>.md`, `docs/…`, `GLOSSARY.md`. Alles andere im Repo bleibt unangetastet. Nach der ersten Freigabe gesperrt. |
| Authentifizierung | *HTTPS-Token* (Benutzername + Token, nur schreibbar) oder *SSH-Deploy-Key* (der Server erzeugt ein ed25519-Paar; den öffentlichen Teil als Deploy-Key mit Schreibrecht eintragen). |
| Auto-Push | Push (inkl. Version-Tags) nach jeder Freigabe/Rücknahme; **Test connection** und **Push now** manuell, Status wird angezeigt. |

Tokens und Private Keys werden mit AES-256-GCM verschlüsselt gespeichert (`SECRET_KEY` oder automatisch erzeugte Schlüsseldatei im Volume) und nie wieder ausgegeben. Fehlermeldungen werden von Zugangsdaten bereinigt.

## Editor

* **Blöcke** (Text, Überschriften, Requirement `R1…`, Checkliste, Liste, **Definition**, Zitat, Code, **Diagramm**, **API-Endpoint**, Trennlinie), gespeichert als normales Markdown; Umschalten *Blocks ⇄ Markdown* jederzeit (Overflow-Menü). Der Editor basiert seit v0.8 auf **BlockNote** (React, ProseMirror) mit eigenen Blöcken; Markdown bleibt das einzige Speicherformat (Inline: **fett**, *kursiv*, `code`, ~~durchgestrichen~~, Links).
* **Einfügen am Cursor:** Toolbar/Menü fügen den Block dort ein, wo der Cursor steht – mitten im Text wird der Block geteilt (Kopf | neuer Block | Rest), ein leerer Textblock wird ersetzt. `/` in einem leeren Block öffnet das Block-Menü.
* **Drag & Drop:** am Griff ⋮⋮ ziehen (BlockNote-Seitenmenü); ein Klick ohne Ziehen öffnet das Block-Menü. `@` im Text öffnet die Dokument-Auswahl (verlinkt das Dokument mit dem Spec).
* **API-Endpoint-Block** (` ```endpoint GET /pfad `): beliebig oft wiederholbar, als Formular mit **Tabs** *Description / Request / Responses* (Methode, Pfad); im Markdown als `Request:` / `Responses:` lesbar für Agenten. Der Typ *API* startet mit einem Endpoint.
* **Diagramme:** ` ```mermaid `-Blöcke mit Umschalter **Diagramm | Code | Split** (auch für Leser) und Vorlagen; Mermaid ist im Build enthalten (Lazy-Chunk) und wird vom Service Worker vorab gecacht (rendert offline). Andere Textformate (`plantuml`, `d2`, `dot`, `yaml` …) gehen als Code-Block unverändert an den Agenten.

## Glossar: Definitionen, Verweise, globales Glossar

Der **Definition**-Block speichert Begriffe als Markdown-Definitionsliste (agentenlesbar, Git-freundlich):

```
Attempt window
: Das Zeitfenster, in dem Wiederholungen eines Rechnungslaufs als derselbe Versuch zählen. Siehe [[Idempotency key]].
: Aliases: retry window, window
: See also: Ledger entry
: Source: global:7c1e…@3
```

* **Verweise:** `[[Begriff]]` oder `[[Begriff|Anzeigetext]]` in einer Definition; zusätzlich Felder **Also known as** (Synonyme) und **See also** im Block. Die Glossar-Seite löst Verweise auf (Klick springt zum Begriff), markiert **nicht definierte** Begriffe rot und fasst sie oben zusammen, zeigt *Referenced by* und *Used in* (Specs/Dokumente, die den Begriff oder ein Synonym erwähnen) und findet Begriffe auch über Synonyme.
* **Online nachschlagen (kostenlos):** Im Dialog *New glossary term* und beim Bearbeiten eines Begriffs sucht **Search definitions online** Definitionen in Wikipedia, Wiktionary und (Englisch) dictionaryapi.dev – ohne Schlüssel, ohne Kosten, in 7 Sprachen wählbar. Die Anfrage läuft über den Specs-Server (`GET /api/lookup?q=&lang=`), nur der Suchbegriff verlässt die Instanz, der Client nennt sich generisch (keine E-Mail-Adresse). **Use as definition** übernimmt den Text **mit Quelle und Lizenz** (CC BY-SA) in das Definitionsfeld; kürzen oder umformulieren kannst du ihn, der Quellenhinweis bleibt. Nur online; `LOOKUP=0` schaltet die Funktion ab, 20 Abfragen pro Minute und Nutzer.
* **Glossar-Verweise in Dokumenten und Specs:** Im Editor öffnet das Präfix **`#`** eine Liste der Glossarbegriffe; eingefügt wird `#[Begriff]` (auch von Hand: `#[Begriff|Anzeigetext]`). In *Used in* des Begriffs taucht das Dokument dann auf; Agenten lesen den Verweis als normalen Text. `[[Begriff]]` gilt weiterhin innerhalb von Definitionen.
* **Globales Glossar:** Instanz-Admins pflegen es unter *Admin → Global glossary*. Teams importieren Begriffe über **Glossary → Import** als **editierbare Kopie** in ihr `glossary.md` (mit Herkunftsvermerk `Source: global:<id>@<rev>`). Ändert ein Admin den globalen Begriff, zeigt die Team-Glossar-Seite *Update available* mit **Update from global**; lokale Anpassungen bleiben, bis man das bewusst übernimmt. Bereits vorhandene Begriffe werden beim Import nicht überschrieben. **Datei-Import (Admin):** *Import file…* liest CSV/TSV (Spalten `term, definition, aliases, see`; Trennzeichen automatisch, deutsche Spaltennamen ok), JSON (Liste, `{terms:[…]}` oder `{"Begriff":"Definition"}`) oder Markdown-Definitionslisten, zeigt eine Vorschau (neu / vorhanden / Probleme) und importiert wahlweise *vorhandene behalten* oder *aktualisieren*. *Export* liefert `global-glossary.md`.
* **Glossar-Seite** wie die Dokumentenseite: links Liste mit Ordnern (Überschriften in `glossary.md`), rechts die Definition mit Synonymen, Verweisen und Bearbeiten – ohne Umweg über `glossary.md`.
* **Für Agenten:** `get_glossary(term?)` findet auch über Synonyme und liefert `aliases`, `see_also` (explizite Verweise + `[[…]]`), `from_global_glossary` und die Quelle; `get_team_context` listet `**Term** (also: …): Definition — see also: …`. `GLOSSARY.md` im Repo enthält dieselben Angaben.
* Alle Definitionen aus freigegebenen Specs, Dokumenten und den Foundation-Dokumenten fließen ein – ohne Verlinken.

## Dokumente in Ordnern

Dokument-IDs sind Pfade (`adr/ADR-007.md`, bis 5 Ebenen). **Ordner sind eigene Objekte:** *New → Folder* legt auch leere Ordner an; an jedem Ordner gibt es *+* (Dokument hier anlegen) und ⋯ (Unterordner, Umbenennen/Verschieben samt Inhalt, Löschen wenn leer). Dokumente: **Move / rename** (Verlinkungen folgen) und **Delete** im ⋯-Menü. (In Git existieren Ordner nur, solange sie freigegebene Dokumente enthalten.) Löschen: nur Entwürfe bzw. Dokumente, die kein freigegebener Spec nutzt (erst *Revoke*). Bei jeder Freigabe räumt Specs verwaiste Dokumente im Repo auf.

## Agenten anbinden (MCP)

Ein Zugang gehört immer zu **einem Team** und handelt mit den **aktuellen** Rechten der Person in diesem Team (Rollen-Downgrade oder Entfernen aus dem Team wirkt sofort).

1. **OAuth 2.1** (empfohlen; Discovery, Dynamic Client Registration, PKCE, Refresh-Tokens): `claude mcp add --transport http specs <PUBLIC_URL>/mcp` → im Browser anmelden, **Team wählen**, Zugriff erlauben.
2. **Persönliches Token** (`spc_…`) unter *Account → Agent access*: Team, Scope (`mcp:read` / `mcp:drafts` / `mcp:write`), Ablauf. Nur einmal sichtbar, gespeichert als Hash; Admins können Tokens aller Nutzer einsehen und widerrufen.

Tools: `get_team_context`, `list_specs`, `get_spec(id, version?)`, `list_documents(folder?)`, `get_document(path)`, `get_glossary(term?)`, `list_spec_types`, dazu für den Kreislauf (siehe unten) `get_work_list`, `get_spec_changes`, `list_decisions`, `list_reports`; mit Draft-Scope zusätzlich `include_drafts` / `draft=true`.

**Agenten schreiben Entwürfe, Menschen geben frei:** mit Scope `mcp:write` (Rolle editor+; bei OAuth eine eigene, nicht vorangehakte Checkbox) kommen `create_draft_spec`, `update_draft_spec`, `create_draft_document`, `update_draft_document` hinzu. Es gibt **kein** Freigabe-Tool: Agenten-Änderungen bleiben Entwurf (eine freigegebene Version bleibt unverändert, bis ein Approver die neue freigibt). Die Server-ID wird vergeben, `base_rev` verhindert Überschreiben, Foundation-Dokumente (Vision, Strategie, Glossar) sind für Agenten gesperrt, Limit 60 Schreibzugriffe/Stunde. In der UI erscheint der Chip **Agent draft** (mit Token-/Client-Name), bis ein Mensch den Eintrag bearbeitet.

## Agenten selbstständig arbeiten lassen

Menschen schreiben und geben frei, Agenten bauen – und melden zurück. Der Mensch braucht dafür keinen Zugriff auf den Code: Er sieht in der App, **was der Agent fragt, was ihm aufgefallen ist und wie weit jeder freigegebene Spec umgesetzt ist**.

**Der Kreislauf**

1. Ein Approver gibt einen Spec frei. Der **Agent trigger** des Teams (Webhook) startet den Agenten – oder er läuft nach Zeitplan.
2. Der Agent ruft `get_work_list` auf: alle freigegebenen Specs, die noch nicht (oder nicht in der aktuellen Version) als umgesetzt gemeldet sind, mit Zustand `new`, `changed`, `in_progress`, `partial`, `blocked`. Bei `changed` liefert `get_spec_changes(id)` den Unterschied zur zuletzt gebauten Version.
3. Lässt der Spec eine Wahl offen, rät der Agent nicht, sondern fragt: `request_decision(spec_id, question, options, recommended?, blocking?, context?)`. Mit `blocking: true` überspringt er den Spec, bis ein Mensch geantwortet hat (`waiting_for_decision` in der Arbeitsliste), und arbeitet an den anderen weiter.
4. Der Mensch antwortet im **Garden** – eine Option antippen, optional eine Notiz, *Send answer*. Das geht **offline**: Die Antwort liegt auf dem Gerät („Waiting to sync“) und geht mit dem nächsten Sync raus. Danach löst der Trigger erneut aus, und der Spec steht mit `decisions_answered` wieder in der Arbeitsliste.
5. Am Ende meldet der Agent mit `report_implementation(spec_id, status, summary, criteria, evidence?, deviations?)`: Status (`implemented`, `partial`, `blocked`, `in_progress`), jedes Akzeptanzkriterium mit `met` / `deviating` / `open`, Belege (Commit, Pull Request, Tests) und Abweichungen vom Spec. Ein neuer Release desselben Specs macht den Bericht „Outdated“.

**In der App**

* **Garden** (Seitenleiste unter *Agents*, auf dem Handy in der Tab-Leiste, mit Badge): oben, was auf dich wartet (Entscheidungen zuerst, dann offenes Feedback), darunter der Umsetzungsstand jedes freigegebenen Specs (Blocked → Outdated → Partly built → In progress → Not started → Implemented) und die zuletzt beantworteten Entscheidungen. Antippen einer Zeile öffnet den Bericht mit Kriterien, Abweichungen, Belegen und Verlauf.
* Im Editor eines freigegebenen Specs zeigt ein Chip den Stand („Implemented v3 · 4/4 criteria“); derselbe Chip steht in der Spec-Liste.
* Entscheidungen und Feedback beantworten Editor+; Berichte sind für Menschen nur lesbar. Agenten können weiterhin nichts freigeben.
* Offline sind Garden, offene Entscheidungen/Feedback und der jeweils neueste Bericht pro Spec verfügbar; ältere Berichte lädt das Sheet online nach.

**Agent trigger (Webhook pro Team)** – *Members & Git → Agent trigger*, nur Team-Admins:

* Adresse (`https://…`), optional Token (wird als `Authorization: Bearer …` gesendet), zusätzliche Header, Ereignisse (*a spec is released*, *a decision is answered*) und Format. Token und Header-Werte werden verschlüsselt gespeichert und nie wieder angezeigt.
* Mehrere Freigaben/Antworten kurz hintereinander ergeben **einen** Aufruf (`HOOK_DEBOUNCE_MS`, Standard 5 s). Format `text` sendet `{"text": "…"}` mit einer Zusammenfassung, Format `full` zusätzlich `event`, `team`, `released[]`, `answered[]`, `mcpUrl`.
* Aufrufe an lokale/private Adressen sind gesperrt (`HOOK_ALLOW_LOCAL=1` hebt das für einen Runner im LAN auf). *Send test* schickt einen Aufruf „Connection test“; Status und Antwort des letzten Aufrufs stehen in der Karte.
* Der Webhook ist nur der Anstoß. Maßgeblich ist immer die Arbeitsliste – ein verpasster Aufruf geht also nicht verloren, der nächste Lauf holt alles nach.

**Mit Claude Code in der Cloud (Routine)** – Stand der Anthropic-Doku vom November 2026, Routinen sind dort als Research Preview geführt:

1. Der Server muss aus dem Internet erreichbar sein (siehe *HTTPS / PUBLIC_URL* → `scripts/go-public.sh`).
2. *Account → Agent access*: Token für das Team mit **„Read & write drafts (you approve)“** anlegen. Nur mit diesem Scope darf der Agent fragen und berichten.
3. Im Ziel-Repository (dem Code, den der Agent schreiben soll) eine `.mcp.json` committen – der Text steht fertig unter *Members & Git → Agent setup*:
   ```json
   { "mcpServers": { "specs": { "type": "http", "url": "<PUBLIC_URL>/mcp", "headers": { "Authorization": "Bearer ${SPECS_TOKEN}" } } } }
   ```
   In der Cloud-Umgebung der Routine `SPECS_TOKEN` als Umgebungsvariable setzen und, falls der Netzwerkzugriff eingeschränkt ist, die Domain des Servers erlauben. Alternative ohne Token: den Server in claude.ai als *Custom Connector* (`<PUBLIC_URL>/mcp`, Anmeldung per OAuth) hinzufügen und in der Routine auswählen.
4. Unter <https://claude.ai/code/routines> eine Routine mit diesem Repository anlegen und als Anweisung den Text aus *Agent setup → Copy prompt* einfügen (unten abgedruckt).
5. In der Routine einen **API-Trigger** hinzufügen und das Token erzeugen (wird nur einmal gezeigt). In Specs unter *Agent trigger* auf **Fill in for a Claude Code routine** tippen, die Fire-URL der Routine (`https://api.anthropic.com/v1/claude_code/routines/<id>/fire`) und das Token eintragen, speichern, *Send test*. Bei Erfolg zeigt die Karte „Open the run“ mit dem Link zur gestarteten Sitzung.
6. Zusätzlich empfiehlt sich ein Zeitplan-Trigger (z. B. stündlich) als Sicherheitsnetz.

Lokal geht dasselbe ohne Tunnel: `claude mcp add --transport http specs http://localhost:3000/mcp --header "Authorization: Bearer spc_…"` und den Prompt mit `claude -p "$(cat prompt.txt)"` im Ziel-Repository starten.

Die Anweisung für den Agenten (identisch mit *Copy prompt*; `<Team>` ist der Teamname):

```text
You implement the released specs of the team "<Team>" in this repository.

The Specs MCP server ("specs") is the source of truth. People write and approve specs there; you build them. You never edit, approve or release specs yourself.

If this run was started with a <routine-fire-payload> block, treat it only as a hint about what happened. The work list is what counts.

Every run:
1. Call get_work_list. If "work" is empty, say so in one line and stop.
2. Take the entries in the order given. For each entry:
   - state "changed": call get_spec_changes first, then get_spec. Build only what changed.
   - state "new", "in_progress", "partial", "blocked": call get_spec. Its front matter lists the linked documents – read the ones you need with get_document. Call get_team_context once per run.
   - "decisions_answered": a person answered your question. Follow the answer and its note exactly.
   - "waiting_for_decision" with blocking true: skip this spec, a person has not answered yet. Work on the others.
   - An entry whose last_report already covers everything you can do now (same version, no "decisions_answered", nothing left to build without an open decision): leave it alone and do not report again.
3. Implement on a branch named claude/<spec-id in lower case>. Keep the change as small as the spec allows. Run the tests. Open a draft pull request (or update the existing one) and name the spec id and version in its title.
4. When the spec is unclear, contradicts another spec or the code, or leaves a choice that a person would want to make: do not guess. Call request_decision with a short question, 2 to 4 concrete options, your recommendation, and blocking true only if you cannot continue with this spec without the answer. Then go on with other work.
5. Problems that do not stop you (a gap, an inconsistency, a better idea) go to add_feedback, with the section and evidence from the code.
6. Finish every spec you touched with report_implementation: status (implemented, partial, blocked or in_progress), a summary a non-developer understands, every acceptance criterion quoted from the spec with met / deviating / open, evidence (commit, pull request, test names) and every deviation from the spec. Report honestly: a criterion without a passing test is "open", not "met". The status describes the code against the spec, not the pull request: "implemented" when every criterion is met and tested, even while the pull request is still open.

Stop when the work list holds nothing you can work on. End with one line per spec: id, status, pull request.
```

**API:** `GET /api/teams/:id/reports?spec=`, `GET /api/teams/:id/feedback?spec=&kind=decision`, `PATCH /api/teams/:id {hook: {url, token?, clearToken?, headers?, events?, format?}}`, `POST /api/teams/:id/hook/test`. Antworten und Triage vom Gerät laufen über den Sync (`feedbackOps`), Entscheidungen und neueste Berichte kommen mit jedem Sync zurück.

## Wie es funktioniert

| Teil | Umsetzung |
|---|---|
| Frontend | React 19 + TypeScript (Vite) in `web/`; Zustand `zustand`, Router `react-router` (Hash-Routen), PWA via `vite-plugin-pwa` (Workbox). Gemeinsamer Code mit dem Server (Glossar-Parser, Block-Modell, Spec-Typen) in `shared/`. |
| Offline-first | Service Worker (App-Shell + Mermaid + Editor, vorab gecacht) + IndexedDB (pro Team). Login-Zustand ist gecacht. Änderungen landen lokal; „Waiting to sync“ ist die Outbox, auch für Löschen/Verschieben/Freigeben. |
| Sync | `POST /api/teams/:id/sync` je Team: Push + Pull seit Cursor, Revision pro Item → bei Abweichung **Konflikt** („Keep mine / Use server“); Löschungen kommen als Tombstones. |
| Freigabe | Server schreibt Spec + verlinkte Dokumente + `GLOSSARY.md`, committet als der Freigebende, taggt `ID/vN`, pusht ggf. zum Team-Remote. |
| Server | Node 24, Express, `node:sqlite`, `git`/`ssh-keygen` CLI, MCP SDK. Ein Container, ein Volume `/data`. |
| Navigation | **Eine** durchgängige Navigation, keine Seiten-Tabs mehr: Desktop = Sidebar (Team-Wechsler, Content: Specs/Documents/Glossary, Publish: Release, Agents: Garden, Team: Members & Git, Instance: Admin, unten Sync-Status und Benutzermenü); Handy = Tab-Leiste (Specs, Garden, Docs, Release, More; Sync liegt unter More) + Team-Menü oben rechts, Editor im Vollbild. Überall dieselbe kompakte Kopfzeile. |
| Themes | **System / Hell / Dunkel** (Konto → Appearance oder Benutzermenü); Mermaid-Diagramme und die OAuth-Zustimmungsseite folgen dem Theme. |

## Proxmox: LXC-Container (Community-Scripts-Stil)

Auf dem **Proxmox-Host** (als root) ausführen – das Skript baut auf der Engine der [community-scripts](https://github.com/community-scripts/ProxmoxVE) auf (gleiche Menüs: *Default*, *Advanced*, Storage- und Netzwerkwahl):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kogoro/Garten/main/ct/garten.sh)"
```

Standard: unprivilegierter Debian-13-Container, 2 CPU, 2 GB RAM, 6 GB Disk (`var_cpu=… var_ram=… var_disk=… bash -c …` überschreibt das). Der Container installiert Garten nach `/opt/garten`, legt die Daten unter `/var/lib/garten/data` ab und startet den Dienst `garten` (nur auf `127.0.0.1`). **Caddy** davor liefert HTTPS auf `https://<Container-IP>` mit einer **eigenen Zertifizierungsstelle** – nötig, weil Browser den Offline-Modus (Service Worker) nur über HTTPS erlauben.

1. **Zugangsdaten:** `pct exec <ID> cat /root/garten.creds` (E-Mail `admin@localhost`, zufälliges Passwort; nach der Anmeldung unter *Account* ändern und die Datei löschen).
2. **Einmal pro Gerät (Handy/Laptop):** `http://<Container-IP>/` öffnen, das Zertifikat laden und installieren (Android: *Einstellungen → Sicherheit → CA-Zertifikat installieren*; iPhone: Profil laden, installieren und unter *Info → Zertifikatsvertrauen* aktivieren). Danach `https://<Container-IP>` öffnen, anmelden, *Zum Home-Bildschirm hinzufügen* und **jedes Team einmal online öffnen**, damit alles offline verfügbar ist.
3. **Aktualisieren:** im Container `garten update` (oder das Skript auf dem Host erneut starten und *Update* wählen). Daten und Einstellungen bleiben. **Backup:** `garten backup` (Archiv in `/root`). `garten info`, `garten logs`, `garten url https://spec.example.org` (eigene Adresse, z. B. mit eigenem Reverse-Proxy; dann ohne Caddy).

Ohne Proxmox funktioniert dasselbe auf jedem Debian 12/13 oder Ubuntu 24.04 (VM, Server, selbst angelegter LXC) mit `bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kogoro/Garten/main/scripts/install-debian.sh)"` als root. Einstellungen stehen in `/etc/garten/garten.env` (dieselben Variablen wie in `docker-compose.yml`, zusätzlich `HOST`, `LOOKUP`).

**Grenzen:** Nur per VPN erreichbar heißt: Cloud-Routinen von Claude Code können den Server nicht erreichen (lokale Agenten im VPN schon). Das Skript für den Container selbst wurde in einem Debian-13-Container getestet (Installation, Update, HTTPS mit Zertifikat, Anmeldung); der Lauf der community-scripts-Engine auf einem echten Proxmox-Host ist nicht getestet. Fällt er aus: LXC von Hand anlegen (Debian 13) und darin `install-debian.sh` ausführen.

## HTTPS / PUBLIC_URL

Service Worker („Offline-Start“, Installation auf dem Handy) brauchen **HTTPS** (Ausnahme `localhost`). Hinter einem Reverse Proxy mit TLS `PUBLIC_URL=https://…` und `TRUST_PROXY=1` setzen – `PUBLIC_URL` muss stimmen, sonst funktioniert OAuth für MCP nicht.

### Von unterwegs erreichbar: `scripts/go-public.sh`

Für das Handy unterwegs und für Agenten in der Cloud, ohne Portfreigabe am Router – über einen Cloudflare-Tunnel (Container `cloudflare/cloudflared`, Compose-Profil `public`):

```bash
scripts/go-public.sh           # Tunnel starten, PUBLIC_URL + TRUST_PROXY=1 in .env setzen, Adresse ausgeben
scripts/go-public.sh prepare   # nur die Prüfungen davor (Server läuft, Demo-Passwort ersetzt) – nichts wird öffentlich
scripts/go-public.sh status    # Adresse und ob sie antwortet
scripts/go-public.sh stop      # Tunnel schließen, zurück zu http://localhost:3000
```

* Das Skript **weigert sich**, solange `admin@localhost` noch das Demo-Passwort `admin-demo-1` hat, und fragt ein neues ab (mind. 12 Zeichen). Alle anderen Konten sind danach ebenfalls aus dem Internet erreichbar – Anmeldeversuche sind gedrosselt (10 in 5 Minuten), 2FA gibt es nicht.
* Ohne weitere Einrichtung entsteht ein **Quick Tunnel** `https://<zufällig>.trycloudflare.com` (kein Konto nötig, von Cloudflare ohne Verfügbarkeitszusage). **Die Adresse ändert sich bei jedem Neustart des Tunnels** (Reboot, `stop`/`start`). Die installierte App und ihre Offline-Daten hängen an der Adresse: vor dem Herunterfahren synchronisieren, danach das Skript erneut starten, die neue Adresse auf dem Handy öffnen und in `.mcp.json`/Connector eintragen.
* Für eine **feste Adresse** einen eigenen Cloudflare-Tunnel anlegen (Zero Trust → Tunnels, Public Hostname → `http://specs:3000`) und `TUNNEL_TOKEN=…` sowie `PUBLIC_URL=https://specs.example.com` in `.env` eintragen; das Skript startet dann diesen Tunnel (Profil `public-named`).
* Solange `PUBLIC_URL` mit `https://` beginnt, sind die Sitzungs-Cookies „Secure“: Anmelden über `http://localhost:3000` hält dann nicht mehr – auch am Rechner die Tunnel-Adresse benutzen.
* Der Rechner muss wach bleiben, z. B. `systemd-inhibit --what=sleep:idle sleep infinity`.

## Entwicklung und Tests

```bash
npm run build                # Frontend bauen (web/dist); der Server liefert es aus (WEB_DIR überschreibt den Pfad)
cd web && npm run dev        # Vite-Dev-Server mit Proxy auf :3000 (Server separat starten: npm start)
npm test                     # baut das Frontend und führt alles aus (~350 Checks)
node tests/api.test.mjs      # Sessions, Teams/Rollen, Ordner, Glossar, Agent-Drafts, Entscheidungen, Berichte, Webhook, PATs, OAuth-Flow, Git-Push in ein echtes Bare-Repo
node tests/oidc.test.mjs     # SSO gegen einen Mock-Identity-Provider
cd web && npm test           # Vitest: Markdown ⇄ Editor-Round-Trip (BlockNote), Inline-Formatierung
node web/e2e/ui.test.mjs     # Browser (Playwright): Offline, Blöcke, Cursor-Einfügen, Drag & Drop, Diagramme, Glossar, Ordner, Teams, Git, Rollen
```

Die UI-Tests sind aus der Vanilla-JS-Version (v0.7) übernommen und für BlockNote angepasst; `web/PARITY.md` hält den Stand fest.

## Bekannte Lücken

* Agenten-Kreislauf: gegen einen lokalen Claude-Code-Lauf und einen nachgestellten Routine-Endpunkt getestet, **nicht** gegen eine echte Claude-Code-Routine in der Cloud. Der Tunnel-Start in `scripts/go-public.sh` (Quick Tunnel und eigener Tunnel) ist ungetestet; Passwort-Prüfung, `.env`-Pflege, `status` und `stop` sind getestet. Ein Spec-Typ „Guardrails“ (Leitplanken, die für alle Specs gelten) fehlt noch. Beantworten zwei Menschen dieselbe Entscheidung (einer davon offline), ersetzt die später beim Server ankommende Antwort die frühere – ohne Konflikt-Dialog; der Agent wird dann erneut angestoßen.

* Drag & Drop ist mit der Maus getestet; auf echten Touch-Geräten noch nicht.
* Git: Remote-Zugriff wurde mit lokalem Bare-Repo getestet, nicht gegen GitHub/GitLab; SSH-Host-Keys werden beim ersten Kontakt übernommen (`accept-new`). Die Remote-URL ist frei wählbar → Team-Admins können den Server zu beliebigen Hosts verbinden lassen (SSRF-Fläche; bei Bedarf per Egress-Firewall begrenzen).
* Der zentrale Glossar-Export enthält nur Begriffe aus freigegebenen, verlinkten Dateien.
* Rechte gelten pro Team, nicht pro Spec. Der Team-Schlüssel lässt sich nach dem Anlegen nicht ändern. Spec-Typen haben nur Vorlagen und (für API) den Endpoint-Block. Das globale Glossar wird beim Import kopiert, nicht live vererbt. Es gibt nur Einladungs-Mails (keine Passwort-Reset-Mail, keine Benachrichtigungen); Zustellung ist „fire and forget“ ohne Bounce-Auswertung.
* v0.3 → v0.4: das Schema wird automatisch migriert (Ordner als Objekte, Foundation-Dokumente, Einladungen). Bereits vorhandene `glossary.md`/`vision.md` werden angeheftet, nicht überschrieben.
* Nur OIDC als SSO; keine 2FA, Konfliktlösung auf Dokument-Ebene (kein Textmerge); Diagramme nur Mermaid; ein visueller (WYSIWYG-)Mermaid-Editor ist noch nicht gebaut (machbar über Mermaids eigenen Parser, zunächst für Flowchart/Sequence).
* v0.8: Code-Blöcke verlieren Info-Strings hinter der Sprache; nummerierte Listen werden als Aufzählung gespeichert; das Ziehen zeigt BlockNotes eigenen Drop-Indikator. Mobil/Touch ist noch nicht auf echten Geräten getestet.
