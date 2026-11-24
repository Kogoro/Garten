// OAuth 2.1 for MCP: discovery, dynamic client registration, PKCE, consent with team choice, refresh token rotation and reuse detection.
//   node --test tests/api/oauth.test.mjs
import assert from 'node:assert/strict';
import { before, describe } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { useServer, makeUser, chain, mcpClient, call, hasParam } from '../helpers.mjs';

describe('OAuth 2.1 for MCP (DCR + PKCE + consent with team choice)', () => {
  const ctx = useServer();
  const step = chain();
  const mcp = (token) => mcpClient(ctx.base, token);
  const redirect = 'http://localhost:9876/callback';
  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };
  const tokenReq = (body) =>
    fetch(asm.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
  let BASE, T1, t2, asm, reg, oauthUser, tok, rt;
  before(async () => {
    ({ base: BASE, T1 } = ctx);
    t2 = (await ctx.admin.post('/api/teams', { name: 'Payments', key: 'PAY' })).data.team; // a team the OAuth user does not belong to
  });
  async function authorize(decision, { scope = 'mcp:read mcp:drafts', pick = 'mcp:drafts', who = oauthUser.c, team = T1 } = {}) {
    const p = pkce();
    const u = new URL(asm.authorization_endpoint);
    Object.entries({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: redirect,
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
      scope,
      state: 'xyz',
      resource: `${BASE}/mcp`,
    }).forEach(([k, v]) => u.searchParams.set(k, v));
    const a = await fetch(u, { redirect: 'manual' });
    const consentUrl = new URL(a.headers.get('location'), BASE);
    const page = await who.req('GET', consentUrl.pathname + consentUrl.search);
    assert.match(page.data, /Test Agent/);
    const form = new URLSearchParams({ request: consentUrl.searchParams.get('request'), decision, team });
    for (const s of [].concat(pick)) form.append('scope', s);
    const d = await who.req('POST', '/oauth/consent', form, { 'content-type': 'application/x-www-form-urlencoded' });
    const loc = d.res.headers.get('location');
    return { p, loc: loc ? new URL(loc) : null, status: d.status, page: page.data };
  }

  step('unauthenticated MCP call points to OAuth metadata', async () => {
    const un = await fetch(`${BASE}/mcp`, { method: 'POST' });
    assert.equal(un.status, 401);
    assert.match(un.headers.get('www-authenticate'), /resource_metadata="[^"]+oauth-protected-resource/);
  });
  step('discovery metadata is served', async () => {
    asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    assert.ok(asm.registration_endpoint && asm.code_challenge_methods_supported.includes('S256'));
  });
  step('dynamic client registration', async () => {
    reg = await (
      await fetch(asm.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Test Agent',
          redirect_uris: [redirect],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      })
    ).json();
    assert.ok(reg.client_id);
  });
  step('user can deny access', async () => {
    oauthUser = await makeUser(ctx, 'editor', '2');
    const denied = await authorize('deny');
    assert.equal(denied.loc.searchParams.get('error'), 'access_denied');
  });
  step('wrong PKCE verifier rejected', async () => {
    const g1 = await authorize('allow');
    assert.ok(
      (
        await tokenReq({
          grant_type: 'authorization_code',
          code: g1.loc.searchParams.get('code'),
          client_id: reg.client_id,
          redirect_uri: redirect,
          code_verifier: randomBytes(32).toString('base64url'),
        })
      ).status >= 400,
    );
  });
  step('authorization code + PKCE → tokens', async () => {
    const g2 = await authorize('allow');
    tok = await (
      await tokenReq({
        grant_type: 'authorization_code',
        code: g2.loc.searchParams.get('code'),
        client_id: reg.client_id,
        redirect_uri: redirect,
        code_verifier: g2.p.verifier,
      })
    ).json();
    assert.ok(tok.access_token && tok.refresh_token);
  });
  step('MCP works with an OAuth access token (team-bound, drafts scope)', async () => {
    const c = await mcp(tok.access_token);
    assert.equal(await hasParam(c, 'get_spec', 'draft'), true);
    assert.ok(JSON.parse((await call(c, 'list_specs')).text).length > 0);
    await c.close();
  });
  step('OAuth connection is listed with its team', async () => {
    assert.ok(
      (await oauthUser.c.get('/api/me/tokens')).data.connections.find((x) => x.clientName === 'Test Agent' && x.teamName === 'specs'),
    );
  });
  step('consent refuses a team the user does not belong to', async () => {
    const nonMember = await authorize('allow', { team: t2.id });
    assert.equal(nonMember.status, 400);
    assert.equal(nonMember.loc, null);
  });
  step('refresh token rotation', async () => {
    rt = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id })).json();
    assert.ok(rt.access_token && rt.access_token !== tok.access_token);
  });
  step('revoking a connection kills its tokens', async () => {
    const connId = (await oauthUser.c.get('/api/me/tokens')).data.connections[0].id;
    await oauthUser.c.del(`/api/me/connections/${connId}`);
    await assert.rejects(async () => (await mcp(rt.access_token)).listTools());
  });
  // SEC-17: a refresh token that was already exchanged is a stolen one – the whole grant ends
  step('SEC-17: showing an already used refresh token again revokes the whole grant', async () => {
    const g = await authorize('allow');
    const t0 = await (
      await tokenReq({
        grant_type: 'authorization_code',
        code: g.loc.searchParams.get('code'),
        client_id: reg.client_id,
        redirect_uri: redirect,
        code_verifier: g.p.verifier,
      })
    ).json();
    const t1 = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: t0.refresh_token, client_id: reg.client_id })).json();
    assert.ok(t1.refresh_token && t1.refresh_token !== t0.refresh_token);
    assert.ok((await tokenReq({ grant_type: 'refresh_token', refresh_token: t0.refresh_token, client_id: reg.client_id })).status >= 400);
    assert.ok((await tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: reg.client_id })).status >= 400);
    await assert.rejects(async () => (await mcp(t1.access_token)).listTools());
  });
  // the consent form only accepts posts from this server's own origin
  step('SEC-17: the consent form refuses a foreign Origin', async () => {
    const p2 = pkce();
    const u2 = new URL(asm.authorization_endpoint);
    Object.entries({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: redirect,
      code_challenge: p2.challenge,
      code_challenge_method: 'S256',
      scope: 'mcp:read',
      state: 'q',
    }).forEach(([k, v]) => u2.searchParams.set(k, v));
    const a2 = await fetch(u2, { redirect: 'manual' });
    const rid = new URL(a2.headers.get('location'), BASE).searchParams.get('request');
    const foreign = await oauthUser.c.req('POST', '/oauth/consent', new URLSearchParams({ request: rid, decision: 'allow', team: T1 }), {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://evil.example',
    });
    assert.equal(foreign.status, 400);
  });
  step('a client asking only for mcp:read (as claude.ai does) can still be granted write on the consent page', async () => {
    const g = await authorize('allow', { scope: 'mcp:read', pick: ['mcp:write'] });
    assert.match(g.page, /value="mcp:drafts"/);
    assert.match(g.page, /value="mcp:write"/);
    assert.doesNotMatch(g.page, /value="mcp:write" checked/); // write stays opt-in
    const t = await (
      await tokenReq({
        grant_type: 'authorization_code',
        code: g.loc.searchParams.get('code'),
        client_id: reg.client_id,
        redirect_uri: redirect,
        code_verifier: g.p.verifier,
      })
    ).json();
    assert.deepEqual(t.scope.split(' ').sort(), ['mcp:drafts', 'mcp:read', 'mcp:write']); // writing implies reading drafts
  });
});
