import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as store from './store.js';
import { getUser, roleIn, perms } from './auth.js';
import { getTeam } from './teams.js';
import { addFeedback, listFeedback, KINDS } from './feedback.js';
import { listTypes, isKnownType } from './specTypes.js';
import { glossaryEntries, CORE_DOCS } from './store.js';
import { hasContent } from '../shared/glossary.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

const writeLog = new Map();

function draftMarkdown(s) {
  const list = s.links.length ? '\n' + s.links.map((l) => `  - ${l}`).join('\n') : ' []';
  return `---\nid: ${s.id}\ntype: ${s.specType}\ntitle: ${JSON.stringify(s.title)}\nstatus: draft\nrev: ${s.rev}\nupdated_by: ${JSON.stringify(s.updatedBy ?? '')}\ndocuments:${list}\n---\n\n# ${s.title}\n\n${s.body.trim()}\n`;
}

/** `canDrafts` = token carries mcp:drafts AND the user's role still has the drafts right. */
function buildServer(team, canDrafts, writer) {
  const t = team.id;
  const server = new McpServer(
    { name: `specs-${team.key.toLowerCase()}`, version: '0.4.0' },
    {
      instructions:
        `Specifications of the team "${team.name}". Call get_team_context first: it returns the team's vision, strategy and glossary ` +
        'whenever they have content. Then use list_specs / get_spec for the approved specifications and get_document for their linked documents.' +
        (writer ? ' You may create and edit DRAFTS (create_draft_spec, update_draft_spec, create_draft_document, update_draft_document); you can never approve or publish – a person reviews your drafts in the Specs app. If you disagree with a spec or find it conflicts with the code, do not edit it: use add_feedback (check list_feedback first).' : ''),
    },
  );

  server.registerTool(
    'list_specs',
    {
      description:
        'List approved (released) specifications with version and linked documents.' +
        (canDrafts ? ' Your token may also see drafts: pass include_drafts=true to list unreleased specs too.' : ''),
      inputSchema: { type: z.string().optional().describe('Only specs of this type, e.g. api, ui, feature'), ...(canDrafts ? { include_drafts: z.boolean().optional() } : {}) },
    },
    async (args) => {
      const labels = Object.fromEntries(listTypes(t).map((x) => [x.key, x.label]));
      const rows = store.approvedSpecs(t).map((s) => ({ id: s.id, type: s.specType, type_label: labels[s.specType] ?? s.specType, title: s.title, status: 'approved', version: s.version, approved_at: s.releasedAt, approved_by: s.releasedBy, documents: s.links }));
      if (canDrafts && args?.include_drafts) {
        for (const s of store.allSpecs(t).filter((x) => x.status !== 'approved')) rows.push({ id: s.id, type: s.specType, type_label: labels[s.specType] ?? s.specType, title: s.title, status: 'draft', version: 0, documents: s.links });
      }
      return text(JSON.stringify(args?.type ? rows.filter((r) => r.type === args.type) : rows, null, 2));
    },
  );

  server.registerTool(
    'get_spec',
    {
      description:
        'Get the released Markdown of a specification (front matter lists linked documents; diagrams are ```mermaid blocks). ' +
        'Optionally pass an older released version.' + (canDrafts ? ' With draft=true returns the current working copy instead.' : ''),
      inputSchema: {
        id: z.string().describe('Spec id, e.g. SPEC-012'),
        version: z.number().int().positive().optional(),
        ...(canDrafts ? { draft: z.boolean().optional() } : {}),
      },
    },
    async ({ id, version, draft }) => {
      const spec = store.getItem(t, id);
      if (!spec || spec.kind !== 'spec') return fail(`No spec "${id}".`);
      if (draft && canDrafts) return text(draftMarkdown(spec));
      if (spec.status !== 'approved') return fail(`No approved spec "${id}".${canDrafts ? ' (It is a draft: pass draft=true.)' : ''}`);
      if (version && version > spec.version) return fail(`${id} has only been released up to v${spec.version}.`);
      try {
        const md = await store.readReleasedSpec(team, id, version);
        store.touchFetched(t, id);
        return text(md);
      } catch {
        return fail(`Version v${version} of ${id} was not found.`);
      }
    },
  );

  server.registerTool(
    'get_document',
    {
      description: 'Get a released document (ADR, schema, ...) by its path, e.g. adr/ADR-007.md.' + (canDrafts ? ' With draft=true returns the working copy.' : ''),
      inputSchema: { name: z.string().describe('Document file name as listed in a spec’s front matter'), ...(canDrafts ? { draft: z.boolean().optional() } : {}) },
    },
    async ({ name, draft }) => {
      if (!store.DOC_ID.test(name)) return fail(`No document "${name}".`);
      if (draft && canDrafts) {
        const d = store.getItem(t, name);
        return d?.kind === 'doc' ? text(d.body) : fail(`No document "${name}".`);
      }
      if (!(await store.isReleasedDoc(team, name))) return fail(`No released document "${name}".`);
      return text(await store.readReleasedDoc(team, name));
    },
  );

  server.registerTool(
    'list_documents',
    { description: 'List released documents (paths, folders included). "always" marks foundation documents (vision, strategy, glossary …) that every task should consider. Optionally only below a folder.', inputSchema: { folder: z.string().optional() } },
    async ({ folder }) => {
      const prefix = folder ? folder.replace(/^\/+|\/+$/g, '') + '/' : '';
      const always = new Set(store.pinnedDocs(t).filter((d) => d.status === 'approved').map((d) => d.id));
      return text(JSON.stringify((await store.releasedDocs(team)).filter((d) => d.startsWith(prefix)).map((path) => ({ path, always: always.has(path) })), null, 2));
    },
  );

  server.registerTool(
    'get_team_context',
    { description: 'The standing context of this team: vision, strategy, any other foundation documents and the glossary. Read this before working on any spec. Parts without content are omitted.' },
    async () => {
      const released = new Map();
      for (const d of store.pinnedDocs(t).filter((x) => x.status === 'approved')) {
        try { const body = await store.readReleasedDoc(team, d.id); if (hasContent(body)) released.set(d.id, body); } catch { /* not in repo (yet) */ }
      }
      const order = ['vision.md', 'strategy.md', ...[...released.keys()].filter((k) => !(k in CORE_DOCS)).sort()];
      let md = `# Team context – ${team.name}\n`;
      for (const id of order) if (released.has(id)) md += `\n---\n<!-- ${id} -->\n${released.get(id).trim()}\n`;
      const terms = await glossaryEntries(team);
      if (terms.length) {
        md += '\n---\n## Glossary\n\n';
        for (const e of terms.sort((a, b) => a.term.localeCompare(b.term))) {
          const see = [...new Set([...e.see, ...e.refs])];
          md += `- **${e.term}**${e.aliases.length ? ` (also: ${e.aliases.join(', ')})` : ''}: ${e.definition}${see.length ? ` — see also: ${see.join(', ')}` : ''} _(${e.source})_\n`;
        }
      }
      if (md.length < 60) md += '\n_Nothing has been written down yet (vision, strategy and glossary are empty)._\n';
      return text(md.slice(0, 80000));
    },
  );

  // ---- writing DRAFTS (scope mcp:write). Agents can never approve or release: a person reviews and approves in the app.
  if (writer) {
    const by = { name: writer.user.name, via: writer.via };
    const REVIEW = 'This is a DRAFT. It is not visible to released-only readers until a person reviews and approves it in the Specs app.';
    const guard = () => {
      const now = Date.now();
      const list = (writeLog.get(`${writer.user.id}|${t}`) ?? []).filter((x) => now - x < 3600_000);
      if (list.length >= 60) throw new store.ApiError('Too many writes in the last hour (limit 60). Ask the user to review the drafts first.', 429);
      list.push(now);
      writeLog.set(`${writer.user.id}|${t}`, list);
    };
    const run = (fn) => async (args) => {
      try { guard(); return text(JSON.stringify(await fn(args), null, 2)); }
      catch (e) { if (e instanceof store.ApiError) return fail(e.message); throw e; }
    };
    const docsOk = (paths) => {
      const missing = (paths ?? []).filter((p) => !store.getItem(t, p) || store.getItem(t, p).kind !== 'doc');
      if (missing.length) throw new store.ApiError(`These documents do not exist: ${missing.join(', ')}. Create them with create_draft_document first.`);
    };
    const body = z.string().max(100_000).describe('Markdown (for typed specs follow list_spec_types). Requirements as "R1 text" lines, tasks as "- [ ] text", diagrams as ```mermaid fences, API endpoints as ```endpoint GET /path fences, definitions as "Term" + ": definition" lines.');

    server.registerTool(
      'add_feedback',
      {
        description: 'Leave feedback on a specification (architecture concerns, conflicts with the code, questions, suggestions, missing information). It does NOT change the spec: a person reads and triages it in the Specs app. Use it instead of editing a released spec you disagree with. Duplicates of an open entry are merged.',
        inputSchema: {
          spec_id: z.string(), kind: z.enum(KINDS).describe('concern = risk or doubt · conflict = contradicts code or another spec · question · suggestion · gap = information is missing'),
          text: z.string().min(1).max(4000), section: z.string().max(80).optional().describe('Section or field the feedback is about, e.g. "## DECISION"'),
          evidence: z.string().max(1000).optional().describe('File path, commit, line or quote that supports it'),
        },
      },
      run(async ({ spec_id, kind, text: tx, section, evidence }) => {
        const f = addFeedback(t, { specId: spec_id, kind, text: tx, section, evidence }, by);
        return { id: f.id, status: f.status, duplicate: !!f.duplicate, note: 'Recorded. A person will triage it; it does not change the spec.' };
      }),
    );

    server.registerTool(
      'list_feedback',
      { description: 'Feedback already left on specs, with its status and the reply of the person who triaged it. Check before adding more.', inputSchema: { spec_id: z.string().optional(), status: z.enum(['open', 'accepted', 'dismissed', 'done']).optional() } },
      run(async ({ spec_id, status }) => listFeedback(t, { specId: spec_id, status }).map((f) => ({ id: f.id, spec: f.specId, version: f.specVersion, kind: f.kind, section: f.section, text: f.text, status: f.status, reply: f.reply || undefined }))),
    );

    server.registerTool(
      'create_draft_spec',
      {
        description: `Create a new DRAFT specification. ${REVIEW} Returns its id and revision.`,
        inputSchema: { title: z.string().min(1).max(200), type: z.string().optional().describe('Spec type key: feature (default), api, ui, data, nfr, integration, or a team-defined type'), body, documents: z.array(z.string()).optional().describe('Paths of existing documents to link') },
      },
      run(async ({ title, type, body: md, documents }) => {
        if (type && !isKnownType(t, type)) throw new store.ApiError(`Unknown spec type "${type}". Known: ${listTypes(t).map((x) => x.key).join(', ')}`);
        docsOk(documents);
        const id = store.nextSpecId(team);
        const item = store.saveItem(t, { id, kind: 'spec', title, body: md, links: documents ?? [], specType: type ?? 'feature' }, 0, by);
        return { id: item.id, rev: item.rev, type: item.specType, status: 'draft', note: REVIEW };
      }),
    );

    server.registerTool(
      'update_draft_spec',
      {
        description: `Change the working copy (draft) of a specification. A released version stays unchanged until a person approves the new one. ${REVIEW} Pass base_rev (from get_spec draft=true or the last write) to avoid overwriting someone else's edit.`,
        inputSchema: { id: z.string(), title: z.string().min(1).max(200).optional(), body: body.optional(), type: z.string().optional(), documents: z.array(z.string()).optional(), base_rev: z.number().int().optional() },
      },
      run(async ({ id, title, body: md, type, documents, base_rev }) => {
        const cur = store.getItem(t, id);
        if (!cur || cur.kind !== 'spec') throw new store.ApiError(`No spec "${id}".`);
        if (base_rev !== undefined && base_rev !== cur.rev) throw new store.ApiError(`Conflict: ${id} is at revision ${cur.rev}, you based your change on ${base_rev}. Read it again (get_spec draft=true) and merge.`, 409);
        if (type && !isKnownType(t, type)) throw new store.ApiError(`Unknown spec type "${type}".`);
        if (documents) docsOk(documents);
        const item = store.saveItem(t, { id, kind: 'spec', title, body: md, links: documents, specType: type }, cur.rev, by);
        return { id: item.id, rev: item.rev, status: item.status, released_version: item.version || null, unreleased_changes: item.rev > item.releasedRev, note: REVIEW };
      }),
    );

    server.registerTool(
      'create_draft_document',
      {
        description: `Create a new DRAFT document (ADR, schema, notes …) at a path like adr/ADR-009.md. Documents are released together with the specs that link them. ${REVIEW}`,
        inputSchema: { path: z.string().min(3).max(120), body },
      },
      run(async ({ path, body: md }) => {
        if (store.isCoreDoc(path)) throw new store.ApiError(`${path} is a foundation document; only people change those.`);
        if (store.getItem(t, path)) throw new store.ApiError(`${path} already exists – use update_draft_document.`);
        const item = store.saveItem(t, { id: path, kind: 'doc', title: path, body: md, links: [] }, 0, by);
        return { path: item.id, rev: item.rev, status: 'draft', note: REVIEW };
      }),
    );

    server.registerTool(
      'update_draft_document',
      {
        description: `Change the working copy of an existing document. Foundation documents (vision, strategy, glossary, pinned) cannot be changed by agents. ${REVIEW}`,
        inputSchema: { path: z.string(), body, base_rev: z.number().int().optional() },
      },
      run(async ({ path, body: md, base_rev }) => {
        const cur = store.getItem(t, path);
        if (!cur || cur.kind !== 'doc') throw new store.ApiError(`No document "${path}".`);
        if (cur.pinned || store.isCoreDoc(path)) throw new store.ApiError(`${path} is a foundation document; only people change those (it goes live without review).`);
        if (base_rev !== undefined && base_rev !== cur.rev) throw new store.ApiError(`Conflict: ${path} is at revision ${cur.rev}, you based your change on ${base_rev}.`, 409);
        const item = store.saveItem(t, { id: path, kind: 'doc', body: md }, cur.rev, by);
        return { path: item.id, rev: item.rev, note: REVIEW };
      }),
    );
  }

  server.registerTool(
    'list_spec_types',
    { description: 'The spec types of this team. Types with a form list their fields: every field is a "## LABEL" section in the Markdown of a spec, written as its kind says (list = "- item" lines, checklist = "- [ ] item", requirements = "R1 text" lines, endpoints = ```endpoint METHOD /path fences, code/diagram = fenced block, select = one of the options). Follow them when you write drafts.' },
    async () => text(JSON.stringify(listTypes(t).map((x) => ({
      key: x.key, label: x.label, description: x.description,
      form: x.form ? x.form.fields.map((f) => ({ section: `## ${f.label}`, kind: f.kind, ...(f.options ? { options: f.options } : {}), ...(f.lang ? { language: f.lang } : {}), ...(f.help ? { hint: f.help } : {}) })) : null,
    })), null, 2)),
  );

  server.registerTool(
    'get_glossary',
    { description: 'The project glossary: all terms defined in released specs and documents, with aliases (synonyms), related terms and their source. Optionally filter by term or alias.', inputSchema: { term: z.string().optional() } },
    async ({ term }) => {
      const q = term?.trim().toLowerCase();
      const entries = (await glossaryEntries(team)).filter((e) => !q || e.term.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q)));
      return text(JSON.stringify(entries.sort((a, b) => a.term.localeCompare(b.term)).map((e) => ({
        term: e.term, definition: e.definition, aliases: e.aliases, see_also: [...new Set([...e.see, ...e.refs])], from_global_glossary: !!e.origin, source: e.source,
      })), null, 2));
    },
  );
  return server;
}

/** Stateless Streamable HTTP; req.auth is set by requireBearerAuth. */
export async function mcpHandler(req, res) {
  const user = getUser(req.auth.extra.userId);
  const team = getTeam(req.auth.extra.teamId);
  const role = team && user ? roleIn(user, team.id) : null;
  if (!role) return res.status(403).json({ error: 'no access to this team' });
  const canDrafts = (req.auth.scopes.includes('mcp:drafts') || req.auth.scopes.includes('mcp:write')) && perms(role).includes('drafts');
  const writer = req.auth.scopes.includes('mcp:write') && perms(role).includes('write')
    ? { user, via: `${req.auth.extra.via === 'pat' ? 'token' : 'agent'}: ${req.auth.extra.label ?? 'MCP client'}`.slice(0, 80) }
    : null;
  const server = buildServer(team, canDrafts, writer);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
