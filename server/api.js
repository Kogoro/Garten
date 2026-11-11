import express from 'express';
import {
  ROLES, perms, requireUser, requireTeam, requireInstanceAdmin, loginWithPassword, startSession, endSession, setPassword, verifyPassword,
  createUser, updateUser, deleteUser, listUsers, getUser, createPat, listPats, revokePat, AuthError, MCP_SCOPES,
  meSummary, members, setMember, removeMember, teamsFor, userFromRequest,
} from './auth.js';
import { db } from './db.js';
import { listConnections, revokeConnection } from './oauth.js';
import { PROJECT_NAME, PUBLIC_URL, OIDC, ALLOW_TEAM_CREATION, MAX_TEAMS_PER_USER } from './config.js';
import {
  createTeam, renameTeam, setFoundationAuto, setAgentPaused, setFeedbackMail, deleteTeamRows, listTeams, teamsCreatedBy, publicGit, saveGitSettings, getTeam, TeamError,
} from './teams.js';
import { lookupDefinitions, LookupError } from './lookup.js';
import { testRemote, pushTeam, generateSshKey } from './gitremote.js';
import { mailEnabled, mailInfo, sendMail, mailError, invitationMail } from './mailer.js';
import { createInvite, listInvites, revokeInvite, inviteByToken, registerFromInvite, acceptForUser, declineForUser, invitesForEmail } from './invites.js';
import { listGlobalTerms, createGlobalTerm, updateGlobalTerm, deleteGlobalTerm, importGlobalTerms, GlossaryError } from './globalGlossary.js';
import { bumpGarden, addFeedback, listFeedback, setFeedback, openCounts, applyFeedbackOps, gardenFeedback, gardenRev } from './feedback.js';
import { listReports, latestReports } from './reports.js';
import { publicHook, saveHook, testHook } from './hooks.js';
import { listTypes, createType, updateType, deleteType, TypeError_ } from './specTypes.js';
import * as store from './store.js';

const me = (u) => ({ ...meSummary(u), invites: invitesForEmail(u.email) });

async function applyChange(ch, team, user, role) {
  const { id, kind, baseRev = 0, fields = {}, approve, revoke } = ch;
  const t = team.id;
  const rights = perms(role);
  try {
    if (!['spec', 'doc', 'folder'].includes(kind)) throw new store.ApiError('invalid kind');
    if (!rights.includes('write')) return { id, status: 'error', forbidden: true, message: `Your role (${role}) cannot edit.` };
    if ((approve || revoke) && !rights.includes('approve')) return { id, status: 'error', forbidden: true, message: `Your role (${role}) cannot ${approve ? 'approve' : 'revoke'}. Ask an approver.` };
    const cur = store.getItem(t, id);
    if (cur && cur.kind !== kind) throw new store.ApiError(`${id} exists as a ${cur.kind}`);

    if (ch.delete) {
      if (!cur) return { id, status: 'applied', deleted: true };
      if (cur.rev !== baseRev) return { id, status: 'conflict', server: cur };
      if (cur.kind === 'doc' && cur.pinned && cur.status === 'approved' && !cur.core) await store.unreleaseDoc(team, id, user);
      store.deleteItem(t, id, baseRev);
      return { id, status: 'applied', deleted: true };
    }
    if (cur && cur.rev !== baseRev) {
      // A retry after a lost response: the server already holds exactly what this change says – it was applied.
      const same = !approve && !revoke && Object.keys(fields).length > 0 && ['title', 'body', 'pinned', 'specType'].every((k) => !(k in fields) || fields[k] === cur[k])
        && (!('links' in fields) || JSON.stringify(fields.links) === JSON.stringify(cur.links));
      return same ? { id, status: 'applied', item: cur } : { id, status: 'conflict', server: cur };
    }
    if (!cur && baseRev !== 0) return { id, status: 'conflict', server: null };

    const hasFields = ['title', 'body', 'links', 'pinned', 'specType'].some((k) => k in fields);
    let item = cur;
    if (!cur || hasFields) {
      const f = { id, kind, title: fields.title, body: fields.body, links: fields.links, pinned: fields.pinned, specType: fields.specType };
      if (f.links && !Array.isArray(f.links)) throw new store.ApiError('links must be an array');
      item = store.saveItem(t, f, baseRev, user);
    }
    if (kind === 'spec' && approve) item = await store.releaseSpec(team, id, user);
    else if (kind === 'spec' && revoke) item = await store.revokeSpec(team, id, user);
    else if (kind === 'doc' && approve) item = await store.releaseDoc(team, id, user);
    if (kind === 'doc' && item.pinned && !approve) {
      if (team.row.foundation_auto) store.scheduleFoundation(t, id, user); // goes live shortly after the last edit
    } else if (kind === 'doc' && !item.pinned && cur?.pinned && cur.status === 'approved') {
      item = await store.unreleaseDoc(team, id, user); // un-pinned: no longer always-on
    }
    return { id, status: 'applied', item };
  } catch (e) {
    // One failing change must not fail the whole batch (the others are already stored); report it per change, with the current item.
    const item = (() => { try { return store.getItem(t, id) ?? undefined; } catch { return undefined; } })();
    if (e instanceof store.ApiError) return { id, status: 'error', message: e.message, ...(item ? { item } : {}) };
    console.error('sync change failed:', id, e);
    return { id, status: 'error', message: 'The server could not publish this change. It will be retried with the next sync.', ...(item ? { item } : {}) };
  }
}
const order = (c) => (c.delete ? (c.kind === 'folder' ? 3 : 2) : c.kind === 'folder' ? -1 : c.kind === 'doc' ? 0 : 1); // folders/docs first, deletions last

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const teamView = (team, role) => ({ id: team.id, key: team.key, name: team.name, role, foundationAuto: !!team.row.foundation_auto, agentPaused: !!team.row.agent_paused, feedbackMail: !!team.row.feedback_mail, mailEnabled, git: publicGit(team), ...(role === 'admin' ? { hook: publicHook(team) } : {}) });

// keeps one admin from using the invite form as a mail cannon
const inviteLog = new Map();
function inviteBudget(teamId) {
  const now = Date.now();
  const list = (inviteLog.get(teamId) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= 30) throw new AuthError('Too many invitations in the last hour – try again later', 429);
  list.push(now);
  inviteLog.set(teamId, list);
}

export function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '5mb' }));

  // ---- public
  r.get('/auth/config', (_req, res) => res.json({ project: PROJECT_NAME, oidc: OIDC ? { name: OIDC.name } : null }));
  r.post('/auth/login', wrap(async (req, res) => {
    if (req.get('x-specs') !== '1') return res.status(403).json({ error: 'missing x-specs header' });
    const user = await loginWithPassword(req.body?.email, req.body?.password, req.ip);
    startSession(res, user, req.get('user-agent'));
    res.json({ me: me(user) });
  }));
  r.post('/auth/logout', (req, res) => { endSession(req, res); res.json({ ok: true }); });

  // invitation links work before sign-in
  r.get('/invites/:token', (req, res) => {
    const inv = inviteByToken(req.params.token);
    if (!inv) return res.status(404).json({ error: 'This invitation is invalid or has expired.' });
    res.json({ invite: { teamName: inv.teamName, role: inv.role, email: inv.email, invitedBy: inv.invitedBy, userExists: inv.userExists } });
  });
  r.post('/invites/:token/accept', wrap(async (req, res) => {
    if (req.get('x-specs') !== '1') return res.status(403).json({ error: 'missing x-specs header' });
    const session = userFromRequest(req);
    if (session) { // existing account, signed in as the invited address
      const teamId = acceptForUser(session, { token: req.params.token });
      return res.json({ me: me(session), teamId });
    }
    const { user, teamId } = await registerFromInvite(req.params.token, { name: req.body?.name, password: req.body?.password });
    startSession(res, user, req.get('user-agent'));
    res.json({ me: me(user), teamId });
  }));

  // ---- everything below needs a session
  r.use(requireUser);

  r.get('/me', (req, res) => res.json({ me: me(req.user), project: PROJECT_NAME, mcpUrl: `${PUBLIC_URL}/mcp`, roles: ROLES, canCreateTeam: ALLOW_TEAM_CREATION || req.user.admin }));
  r.post('/me/password', wrap(async (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
    if (row.password_hash && !(await verifyPassword(String(req.body?.current ?? ''), row.password_hash))) throw new AuthError('Current password is wrong', 403);
    await setPassword(req.user.id, req.body?.password);
    res.json({ ok: true });
  }));
  r.post('/me/invites/:id/accept', (req, res) => { const teamId = acceptForUser(req.user, { inviteId: req.params.id }); res.json({ me: me(req.user), teamId }); });
  r.post('/me/invites/:id/decline', (req, res) => res.json({ ok: declineForUser(req.user, req.params.id), me: me(req.user) }));

  // ---- personal MCP tokens + connected OAuth agents (each bound to one team)
  r.get('/me/tokens', (req, res) => res.json({ tokens: listPats(req.user.id), connections: listConnections(req.user.id) }));
  r.post('/me/tokens', wrap(async (req, res) => {
    res.json(createPat(req.user, { name: req.body?.name, scopes: req.body?.scopes, days: req.body?.days, teamId: req.body?.teamId }));
  }));
  r.delete('/me/tokens/:id', (req, res) => res.json({ ok: revokePat(req.user.id, req.params.id) }));
  r.delete('/me/connections/:id', (req, res) => res.json({ ok: revokeConnection(req.user.id, req.params.id) }));

  // ---- free definition lookup (Wikipedia / Wiktionary / dictionaryapi.dev), proxied so the browser never talks to third parties
  r.get('/lookup', wrap(async (req, res) => res.json(await lookupDefinitions(req.query.q, req.query.lang, req.user.id))));

  // ---- global glossary: everybody reads it (to import terms), instance admins maintain it
  r.get('/glossary/global', (_req, res) => res.json({ terms: listGlobalTerms() }));
  r.post('/glossary/global', requireInstanceAdmin, wrap(async (req, res) => res.json({ term: createGlobalTerm(req.body, req.user), terms: listGlobalTerms() })));
  r.post('/glossary/global/import', requireInstanceAdmin, wrap(async (req, res) => res.json({ result: importGlobalTerms(req.body?.terms, req.body?.mode, req.user), terms: listGlobalTerms() })));
  r.patch('/glossary/global/:id', requireInstanceAdmin, wrap(async (req, res) => res.json({ term: updateGlobalTerm(req.params.id, req.body, req.user), terms: listGlobalTerms() })));
  r.delete('/glossary/global/:id', requireInstanceAdmin, (req, res) => res.json({ ok: deleteGlobalTerm(req.params.id), terms: listGlobalTerms() }));

  // ---- teams: everybody can create their own team and invites others into it
  r.get('/teams', (req, res) => res.json({ teams: teamsFor(req.user).map(({ team, role }) => teamView(team, role)) }));
  r.post('/teams', wrap(async (req, res) => {
    if (!ALLOW_TEAM_CREATION && !req.user.admin) throw new TeamError('Creating teams is restricted to administrators on this server', 403);
    if (!req.user.admin && teamsCreatedBy(req.user.id) >= MAX_TEAMS_PER_USER) throw new TeamError(`You can create up to ${MAX_TEAMS_PER_USER} teams`, 403);
    const team = createTeam({ name: req.body?.name, key: req.body?.key, createdBy: req.user.id });
    setMember(team.id, req.user.id, 'admin');
    store.ensureFoundation(team);
    res.json({ team: teamView(team, 'admin'), me: me(req.user) });
  }));

  const team = express.Router({ mergeParams: true });
  r.use('/teams/:tid', team);

  // one round trip: push local changes, pull everything newer than `since`
  team.post('/sync', requireTeam('read'), wrap(async (req, res) => {
    const { since = 0, changes = [], feedbackOps, gardenRev: have } = req.body ?? {};
    if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes must be an array' });
    const results = [];
    for (const ch of [...changes].sort((a, b) => order(a) - order(b))) results.push(await applyChange(ch, req.team, req.user, req.role));
    // decisions and triage made offline travel with the sync
    const t = req.team.id;
    const fbResults = !Array.isArray(feedbackOps) || !feedbackOps.length ? []
      : perms(req.role).includes('write') ? applyFeedbackOps(t, feedbackOps, req.user)
        : feedbackOps.map((op) => ({ id: op?.id, ok: false, error: `Your role (${req.role}) cannot answer or triage.` }));
    const rev = gardenRev(t);
    res.json({
      results, fbResults, items: store.itemsSince(t, Number(since) || 0), cursor: store.maxSeq(t), me: me(req.user), project: PROJECT_NAME, mcpUrl: `${PUBLIC_URL}/mcp`, specTypes: listTypes(t), feedbackOpen: openCounts(t),
      ...(have === rev ? {} : { garden: { rev, feedback: gardenFeedback(t), reports: latestReports(t) } }), // what the garden view needs offline; only sent when it changed
    });
  }));

  // feedback on specs: everyone reads, editors+ leave and triage it
  team.get('/feedback', requireTeam('read'), (req, res) => res.json({ feedback: listFeedback(req.team.id, { specId: req.query.spec, status: req.query.status, kind: req.query.kind }) }));
  team.post('/feedback', requireTeam('write'), wrap(async (req, res) => res.json({ feedback: addFeedback(req.team.id, req.body ?? {}, { id: req.user.id, name: req.user.name, via: null }) })));
  team.patch('/feedback/:id', requireTeam('write'), wrap(async (req, res) => res.json({ feedback: setFeedback(req.team.id, req.params.id, req.body ?? {}, req.user) })));

  // implementation reports: agents write them through MCP, everyone in the team reads them
  team.get('/reports', requireTeam('read'), (req, res) => res.json({ reports: listReports(req.team.id, { specId: req.query.spec ? String(req.query.spec) : undefined }) }));

  team.get('/', requireTeam(), (req, res) => res.json({ team: teamView(req.team, req.role) }));
  team.patch('/', requireTeam('admin'), wrap(async (req, res) => {
    let t = req.team;
    if (req.body?.name !== undefined) t = renameTeam(t.id, req.body.name);
    if (req.body?.foundationAuto !== undefined) {
      t = setFoundationAuto(t.id, !!req.body.foundationAuto);
      if (t.row.foundation_auto) await store.startupSweep(); // catch up on documents edited while auto-release was off
    }
    if (req.body?.feedbackMail !== undefined) t = setFeedbackMail(t.id, !!req.body.feedbackMail);
    if (req.body?.agentPaused !== undefined) { t = setAgentPaused(t.id, !!req.body.agentPaused); bumpGarden(t.id); }
    if (req.body?.hook !== undefined) t = saveHook(t.id, req.body.hook ?? {});
    res.json({ team: teamView(t, req.role) });
  }));
  team.post('/hook/test', requireTeam('admin'), wrap(async (req, res) => res.json(await testHook(req.team.id))));
  team.post('/leave', requireTeam(), wrap(async (req, res) => {
    if (req.user.admin && !members(req.team.id).some((m) => m.id === req.user.id)) throw new AuthError('Instance admins are not members – nothing to leave');
    removeMember(req.team.id, req.user.id);
    res.json({ me: me(req.user) });
  }));
  team.delete('/', requireInstanceAdmin, requireTeam(), wrap(async (req, res) => {
    if (String(req.body?.confirmKey ?? '').toUpperCase() !== req.team.key) throw new TeamError(`Type the team key (${req.team.key}) to confirm`);
    await store.deleteTeamData(req.team);
    deleteTeamRows(req.team.id);
    res.json({ ok: true, me: me(req.user) });
  }));

  // ---- spec types (built-in + team-defined)
  team.get('/spec-types', requireTeam('read'), (req, res) => res.json({ types: listTypes(req.team.id) }));
  team.post('/spec-types', requireTeam('admin'), wrap(async (req, res) => res.json({ type: createType(req.team.id, req.body), types: listTypes(req.team.id) })));
  team.patch('/spec-types/:key', requireTeam('admin'), wrap(async (req, res) => res.json({ type: updateType(req.team.id, req.params.key, req.body), types: listTypes(req.team.id) })));
  team.delete('/spec-types/:key', requireTeam('admin'), wrap(async (req, res) => { deleteType(req.team.id, req.params.key); res.json({ types: listTypes(req.team.id) }); }));

  // ---- members + invitations
  team.get('/members', requireTeam('read'), (req, res) => res.json({ members: members(req.team.id), roles: ROLES, invites: req.role === 'admin' ? listInvites(req.team.id) : [] }));
  team.post('/invites', requireTeam('admin'), wrap(async (req, res) => {
    inviteBudget(req.team.id);
    const out = createInvite({ team: req.team, email: req.body?.email, role: req.body?.role, by: req.user });
    let emailed = false;
    let emailError = null;
    if (mailEnabled) { // the link is always returned too, so a failing mail server never blocks an invitation
      try { await sendMail({ to: out.invite.email, ...invitationMail({ teamName: req.team.name, inviterName: req.user.name, role: out.invite.role, link: out.link, expiresAt: out.invite.expiresAt, userExists: out.userExists }) }); emailed = true; }
      catch (e) { emailError = `The e-mail could not be sent (${mailError(e)}). Send the link yourself.`; console.error('invite mail:', mailError(e)); }
    }
    res.json({ link: out.link, userExists: out.userExists, invite: out.invite, invites: listInvites(req.team.id), mailEnabled, emailed, emailError });
  }));
  team.delete('/invites/:id', requireTeam('admin'), (req, res) => { revokeInvite(req.team.id, req.params.id); res.json({ invites: listInvites(req.team.id) }); });
  team.patch('/members/:uid', requireTeam('admin'), wrap(async (req, res) => {
    const cur = members(req.team.id).find((m) => m.id === req.params.uid);
    if (!cur) throw new AuthError('Not a member of this team', 404);
    if (cur.role === 'admin' && req.body?.role !== 'admin' && members(req.team.id).filter((m) => m.role === 'admin').length <= 1)
      throw new AuthError('A team needs at least one team admin (promote someone else first)');
    setMember(req.team.id, req.params.uid, req.body?.role);
    res.json({ members: members(req.team.id) });
  }));
  team.delete('/members/:uid', requireTeam('admin'), wrap(async (req, res) => {
    removeMember(req.team.id, req.params.uid);
    res.json({ members: members(req.team.id) });
  }));

  // ---- Git connection of the team
  team.put('/git', requireTeam('admin'), wrap(async (req, res) => {
    const t = saveGitSettings(req.team.id, req.body ?? {}, { rootLocked: store.hasReleases(req.team.id) });
    res.json({ git: publicGit(t) });
  }));
  team.post('/git/ssh-key', requireTeam('admin'), wrap(async (req, res) => {
    const publicKey = await generateSshKey(req.team.id);
    res.json({ publicKey, git: publicGit(getTeam(req.team.id)) });
  }));
  team.post('/git/test', requireTeam('admin'), wrap(async (req, res) => res.json(await testRemote(req.team.id))));
  team.post('/git/push', requireTeam('approve'), wrap(async (req, res) => {
    const result = await pushTeam(req.team.id);
    res.json({ ...result, git: publicGit(getTeam(req.team.id)) });
  }));

  // ---- instance administration: teams + accounts (people are invited by team admins, not created here)
  const admin = [requireInstanceAdmin];
  const withCounts = (u) => ({ ...u, tokens: listPats(u.id).length, connections: listConnections(u.id).length, teams: teamsFor(u).map(({ team, role }) => ({ id: team.id, name: team.name, role })) });
  r.post('/admin/mail/test', ...admin, wrap(async (req, res) => {
    if (!mailEnabled) throw new AuthError('No mail server configured (set SMTP_URL)', 400);
    try { await sendMail({ to: req.user.email, subject: 'Specs: test e-mail', text: 'E-mail delivery from your Specs server works.\n', html: '<p>E-mail delivery from your Specs server works.</p>' }); }
    catch (e) { throw new AuthError(`Sending failed: ${mailError(e)}`, 502); }
    res.json({ ok: true, to: req.user.email });
  }));
  r.get('/admin/teams', ...admin, (_req, res) => res.json({
    mail: mailInfo(),
    teams: listTeams().map((t) => ({
      id: t.id, key: t.key, name: t.name, createdAt: t.createdAt, members: members(t.id).length,
      items: store.count(t.id), gitUrl: t.row.git_url ?? '', createdBy: t.row.created_by ? getUser(t.row.created_by)?.email ?? null : null,
    })),
  }));
  r.get('/users', ...admin, (_req, res) => res.json({ users: listUsers().map(withCounts), roles: ROLES, scopes: MCP_SCOPES }));
  // programmatic account creation (automation, first setup); the UI uses invitations
  r.post('/users', ...admin, wrap(async (req, res) => {
    const { email, name, admin: isAdmin, password, teamId, role } = req.body ?? {};
    const user = await createUser({ email, name, admin: !!isAdmin, password: password || undefined });
    if (teamId && getTeam(teamId)) setMember(teamId, user.id, role ?? 'viewer');
    res.json({ user: withCounts(user) });
  }));
  r.patch('/users/:id', ...admin, wrap(async (req, res) => {
    const { admin: isAdmin, disabled, name, password } = req.body ?? {};
    res.json({ user: withCounts(await updateUser(req.params.id, { admin: isAdmin, disabled, name, password }, req.user)) });
  }));
  r.delete('/users/:id', ...admin, wrap(async (req, res) => { deleteUser(req.params.id, req.user); res.json({ ok: true }); }));
  r.get('/users/:id/tokens', ...admin, (req, res) => {
    if (!getUser(req.params.id)) return res.status(404).json({ error: 'unknown user' });
    res.json({ tokens: listPats(req.params.id), connections: listConnections(req.params.id) });
  });
  r.delete('/users/:id/tokens/:tid', ...admin, (req, res) => res.json({ ok: revokePat(req.params.id, req.params.tid) }));
  r.delete('/users/:id/connections/:cid', ...admin, (req, res) => res.json({ ok: revokeConnection(req.params.id, req.params.cid) }));

  r.use((err, _req, res, next) => {
    if (err instanceof AuthError || err instanceof TeamError || err instanceof store.ApiError || err instanceof GlossaryError || err instanceof LookupError || err instanceof TypeError_) return res.status(err.status).json({ error: err.message });
    next(err);
  });
  return r;
}
