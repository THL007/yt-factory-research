// yt-factory-api: Research stage API for the YT factory.
// Neon (HTTP SQL, no driver) + R2 + role-pegged access tokens.
// Config: DATABASE_URL (env secret, or R2 config/secrets.json set once through POST /bootstrap),
// WEBHOOK_URL (var), webhook signing secret (set by an owner in the app, kept in R2). Binding: BUCKET (R2).

const ADMIN_ROLES = new Set(['owner', 'admin']);
const RESEARCH_ROLES = new Set(['owner', 'admin', 'research']);
const READ_ROLES = new Set(['owner', 'admin', 'research', 'content', 'production', 'publish']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- config ----------
let CFG = null;
async function loadConfig(env) {
  if (CFG && Date.now() - CFG.at < 60e3) return CFG;
  const stored = await env.BUCKET.get('config/secrets.json').then((o) => (o ? o.json() : {})).catch(() => ({}));
  CFG = { at: Date.now(), databaseUrl: env.DATABASE_URL || stored.database_url || '', webhookSecret: env.WEBHOOK_SECRET || stored.webhook_secret || '' };
  return CFG;
}
async function saveConfig(env, patch) {
  const cur = await env.BUCKET.get('config/secrets.json').then((o) => (o ? o.json() : {})).catch(() => ({}));
  await env.BUCKET.put('config/secrets.json', JSON.stringify({ ...cur, ...patch }), { httpMetadata: { contentType: 'application/json' } });
  CFG = null;
}

// ---------- Neon over HTTP ----------
function neonEndpoint(url) {
  const host = new URL(url.replace(/^postgres(ql)?:/, 'https:')).hostname;
  return `https://${host}/sql`;
}
// Neon's HTTP endpoint takes params as text (or null), like the serverless driver sends them.
const toParam = (v) => (v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
function prep(b) {
  if (b.queries) return { queries: b.queries.map((x) => ({ query: x.query, params: (x.params || []).map(toParam) })) };
  return { query: b.query, params: (b.params || []).map(toParam) };
}
async function sqlRaw(env, rawBody, extraHeaders = {}) {
  const body = prep(rawBody);
  const { databaseUrl } = await loadConfig(env);
  if (!databaseUrl) throw new HttpError(503, 'database not configured yet');
  const res = await fetch(neonEndpoint(databaseUrl), {
    method: 'POST',
    headers: { 'Neon-Connection-String': databaseUrl, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(500, `db: ${data.message || res.status}`);
  return data;
}
async function q(env, query, params = []) {
  return (await sqlRaw(env, { query, params })).rows;
}
async function one(env, query, params = []) {
  return (await q(env, query, params))[0] || null;
}
// Several statements in one transaction.
async function tx(env, queries) {
  const data = await sqlRaw(env, { queries }, { 'Neon-Batch-Isolation-Level': 'ReadCommitted' });
  return data.results.map((r) => r.rows);
}

// ---------- helpers ----------
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const newId = (p) => `${p}_${hex(8)}`;
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (data, status = 200, h = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...h } });
async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'invalid JSON body'); }
}
const str = (v, max = 4000) => (v == null ? null : String(v).slice(0, max));

async function audit(env, actor, action, type, id, detail) {
  await q(env, `INSERT INTO audit_events (id, actor_user_id, action, entity_type, entity_id, detail_json, created_at)
                VALUES ($1,$2,$3,$4,$5,$6,now())`, [newId('aud'), actor, action, type, id, JSON.stringify(detail || {})]);
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// OpenBot webhook routine: body {type, occurredAt, data}, HMAC-SHA256 over "<ts>.<delivery>.<body>".
async function notify(env, ctx, type, data) {
  const { webhookSecret } = await loadConfig(env);
  if (!env.WEBHOOK_URL || !webhookSecret) return;
  const body = JSON.stringify({ type, occurredAt: new Date().toISOString(), data });
  const ts = String(Math.floor(Date.now() / 1000));
  const delivery = `ytf-${hex(12)}`;
  const sig = await hmacHex(webhookSecret, `${ts}.${delivery}.${body}`);
  ctx.waitUntil(fetch(env.WEBHOOK_URL, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'x-openbot-timestamp': ts, 'x-openbot-delivery-id': delivery, 'x-openbot-signature': `sha256=${sig}` },
  }).then(async (r) => { if (r.status >= 400) console.error('webhook', r.status, await r.text()); }).catch((e) => console.error('webhook', e)));
}

// ---------- auth ----------
async function authenticate(env, req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(ytf_[A-Za-z0-9]+)$/);
  if (!m) throw new HttpError(401, 'missing or malformed token');
  const row = await one(env, `
    SELECT t.id AS token_id, t.label, t.last_used_at, u.id AS user_id, u.username, u.display_name, u.kind, r.code AS role
      FROM access_tokens t JOIN users u ON u.id = t.user_id JOIN roles r ON r.id = t.role_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.deleted_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > now())`, [await sha256(m[1])]);
  if (!row) throw new HttpError(401, 'token invalid, revoked or expired');
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 5 * 60e3) {
    await q(env, 'UPDATE access_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]);
  }
  return row;
}
function need(me, roles) {
  if (!roles.has(me.role)) throw new HttpError(403, `role ${me.role} cannot do this`);
}

// ---------- research ----------
const JOB_LIST_SQL = `
  SELECT j.id, j.mode, j.seed_topic, j.seed_video_url, j.status, j.assignee_kind, j.auto_handoff,
         j.created_at, j.updated_at, j.finished_at, j.error, j.video_id,
         c.id AS channel_id, c.name AS channel_name, v.title_working, v.stage,
         au.display_name AS assigned_name,
         (SELECT b.angle FROM research_briefs b WHERE b.job_id = j.id ORDER BY b.version DESC LIMIT 1) AS angle
    FROM research_jobs j JOIN channels c ON c.id = j.channel_id JOIN video_tickets v ON v.id = j.video_id
    LEFT JOIN users au ON au.id = j.assigned_user_id`;

async function getJob(env, id) {
  const job = await one(env, `${JOB_LIST_SQL} WHERE j.id = $1`, [id]);
  if (!job) throw new HttpError(404, 'job not found');
  const brief = await one(env, `SELECT * FROM research_briefs WHERE job_id = $1 ORDER BY version DESC LIMIT 1`, [id]);
  let facts = [], references = [];
  if (brief) {
    facts = await q(env, `SELECT id, position, claim, source_url, source_title, verified FROM research_facts WHERE brief_id = $1 ORDER BY position`, [brief.id]);
    references = await q(env, `SELECT * FROM reference_videos WHERE brief_id = $1 ORDER BY kind DESC, views_seen DESC NULLS LAST`, [brief.id]);
  }
  const runs = await q(env, `SELECT id, model, status, input_tokens, output_tokens, cost_usd, tool_calls, error, started_at, finished_at
                               FROM agent_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 10`, [id]);
  return { job, brief, facts, references, runs };
}

// Hand-off gate (human or agent). The agent's automatic hand-off also needs 3 facts read at the source.
function briefChecks(b, facts, refs, { auto = false } = {}) {
  const missing = [];
  const sourced = facts.filter((f) => /^https?:\/\//.test(f.source_url || ''));
  if (!b?.angle) missing.push('angle');
  if (sourced.length < 5) missing.push('5 facts with sources');
  if (refs.filter((r) => r.kind === 'competitor').length < 3) missing.push('3 competitor videos');
  if (auto && sourced.filter((f) => f.verified).length < 3) missing.push('3 verified facts');
  return missing;
}

async function saveBrief(env, me, jobId, input) {
  const job = await one(env, 'SELECT id, video_id, status FROM research_jobs WHERE id = $1', [jobId]);
  if (!job) throw new HttpError(404, 'job not found');
  if (['handed_off', 'cancelled'].includes(job.status)) throw new HttpError(409, `job is ${job.status}`);
  const prev = await one(env, 'SELECT max(version) AS v FROM research_briefs WHERE job_id = $1', [jobId]);
  const version = (prev?.v || 0) + 1;
  const briefId = newId('brf');
  const facts = Array.isArray(input.facts) ? input.facts.slice(0, 30) : [];
  const refs = Array.isArray(input.references) ? input.references.slice(0, 20) : [];
  const queries = [{
    query: `INSERT INTO research_briefs (id, job_id, video_id, version, angle, why_now, audience, whats_new, viral_breakdown,
              remix_extra, title_ideas, asset_notes, rights_flags, author_kind, author_user_id, r2_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    params: [briefId, jobId, job.video_id, version, str(input.angle), str(input.why_now), str(input.audience), str(input.whats_new),
      input.viral_breakdown ? JSON.stringify(input.viral_breakdown) : null, str(input.remix_extra),
      JSON.stringify((input.title_ideas || []).slice(0, 10).map((t) => str(t, 200))),
      JSON.stringify((input.asset_notes || []).slice(0, 20)), JSON.stringify((input.rights_flags || []).slice(0, 20).map((t) => str(t, 500))),
      me.kind === 'agent' ? 'agent' : 'human', me.user_id, str(input.r2_key, 500)],
  }];
  facts.forEach((f, i) => queries.push({
    query: `INSERT INTO research_facts (id, brief_id, position, claim, source_url, source_title, verified) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    params: [newId('fct'), briefId, i, str(f.claim, 1000) || '', /^https?:\/\//.test(f.source_url || '') ? str(f.source_url, 1000) : null, str(f.source_title, 300),
      !!f.verified && /^https?:\/\//.test(f.source_url || '')],
  }));
  refs.forEach((r) => {
    if (!r.url) return;
    queries.push({
      query: `INSERT INTO reference_videos (id, brief_id, kind, youtube_id, url, title, channel_name, views_seen, views_seen_at, duration_s, notes, thumbnail_r2_key)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      params: [newId('ref'), briefId, r.kind === 'seed' ? 'seed' : 'competitor', str(r.youtube_id, 32), str(r.url, 500), str(r.title, 300),
        str(r.channel_name, 200), Number.isFinite(+r.views_seen) && r.views_seen !== null && r.views_seen !== '' ? Math.round(+r.views_seen) : null,
        r.views_seen != null && r.views_seen !== '' ? new Date().toISOString() : null,
        Number.isFinite(+r.duration_s) && r.duration_s !== null ? Math.round(+r.duration_s) : null, str(r.notes, 2000), str(r.thumbnail_r2_key, 500)],
    });
  });
  queries.push({ query: 'UPDATE research_jobs SET updated_at = now() WHERE id = $1', params: [jobId] });
  queries.push({ query: 'UPDATE video_tickets SET niche_angle = $2, updated_at = now() WHERE id = $1', params: [job.video_id, str(input.angle, 500)] });
  await tx(env, queries);
  return { brief_id: briefId, version };
}

async function handoff(env, ctx, me, jobId) {
  const { job, brief, facts, references } = await getJob(env, jobId);
  if (job.status === 'handed_off') return { ok: true, already: true };
  if (!brief) throw new HttpError(409, 'no brief yet');
  const missing = briefChecks(brief, facts, references);
  if (missing.length) throw new HttpError(409, `brief incomplete: ${missing.join(', ')}`);
  const content = await one(env, `SELECT owner_user_id FROM video_tickets WHERE id = $1`, [job.video_id]);
  await tx(env, [
    { query: `UPDATE research_jobs SET status = 'handed_off', handed_off_at = now(), handed_off_by_user_id = $2, updated_at = now(), finished_at = coalesce(finished_at, now()) WHERE id = $1`, params: [jobId, me.user_id] },
    { query: `UPDATE video_tickets SET stage = 'script', niche_angle = $2, titles_json = $3, owner_user_id = NULL, updated_at = now() WHERE id = $1`,
      params: [job.video_id, brief.angle, JSON.stringify(brief.title_ideas || [])] },
  ]);
  await audit(env, me.user_id, 'research.handoff', 'video_ticket', job.video_id, { job_id: jobId, brief_version: brief.version, prev_owner: content?.owner_user_id });
  // The agent mirrors to Obsidian itself; a person's hand-off wakes the server to do it.
  if (me.kind !== 'agent') await notify(env, ctx, 'research.handed_off', { job_id: jobId, video_id: job.video_id });
  return { ok: true, video_id: job.video_id, stage: 'script' };
}

// ---------- router ----------
async function route(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  let k;

  if (p === '/' || p === '/health') {
    const c = await loadConfig(env);
    return json({ ok: true, service: 'yt-factory-api', database: !!c.databaseUrl, webhook: !!(env.WEBHOOK_URL && c.webhookSecret) });
  }

  // One-time: the server sends the Neon URL with the nonce whose sha256 is BOOTSTRAP_HASH. Refused once set.
  if (p === '/bootstrap' && m === 'POST') {
    const b = await body(req);
    if (!env.BOOTSTRAP_HASH || (await sha256(String(b.nonce || ''))) !== env.BOOTSTRAP_HASH) throw new HttpError(403, 'forbidden');
    if ((await loadConfig(env)).databaseUrl) throw new HttpError(409, 'already configured');
    if (!/^postgres(ql)?:\/\/[^\s]+$/.test(b.database_url || '')) throw new HttpError(400, 'database_url');
    await saveConfig(env, { database_url: b.database_url });
    return json({ ok: true });
  }

  const me = await authenticate(env, req);

  if (p === '/me' && m === 'GET') return json({ user: { id: me.user_id, username: me.username, display_name: me.display_name, kind: me.kind }, role: me.role, token_label: me.label });

  if (p === '/channels' && m === 'GET') {
    need(me, READ_ROLES);
    return json(await q(env, `SELECT id, name, niche, language, status FROM channels WHERE deleted_at IS NULL ORDER BY name`));
  }

  // --- research jobs
  if (p === '/research/jobs' && m === 'GET') {
    need(me, READ_ROLES);
    const status = url.searchParams.get('status');
    const rows = status
      ? await q(env, `${JOB_LIST_SQL} WHERE j.status = ANY(string_to_array($1, ',')) ORDER BY j.created_at DESC LIMIT 200`, [status])
      : await q(env, `${JOB_LIST_SQL} ORDER BY j.created_at DESC LIMIT 200`);
    return json(rows);
  }
  if (p === '/research/jobs' && m === 'POST') {
    need(me, RESEARCH_ROLES);
    const b = await body(req);
    const ch = await one(env, 'SELECT id FROM channels WHERE id = $1 AND deleted_at IS NULL', [b.channel_id]);
    if (!ch) throw new HttpError(400, 'channel_id unknown');
    const mode = b.mode === 'viral_breakdown' ? 'viral_breakdown' : 'topic';
    if (!b.seed_topic && !b.seed_video_url) throw new HttpError(400, 'seed_topic or seed_video_url required');
    if (mode === 'viral_breakdown' && !/^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(b.seed_video_url || '')) throw new HttpError(400, 'viral breakdown needs a YouTube link');
    const assignee = b.assignee_kind === 'human' ? 'human' : 'agent';
    const videoId = newId('vid'), jobId = newId('rsj');
    const title = str(b.seed_topic, 200) || 'Breakdown: ' + str(b.seed_video_url, 150);
    await tx(env, [
      { query: `INSERT INTO video_tickets (id, channel_id, stage, owner_user_id, title_working, created_at, updated_at) VALUES ($1,$2,'idea',$3,$4,now(),now())`,
        params: [videoId, b.channel_id, assignee === 'human' ? me.user_id : 'usr_agent_research', title] },
      { query: `INSERT INTO research_jobs (id, video_id, channel_id, mode, seed_topic, seed_video_url, notes, status, assignee_kind, assigned_user_id, requested_by_user_id, auto_handoff)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        params: [jobId, videoId, b.channel_id, mode, str(b.seed_topic, 500), str(b.seed_video_url, 500), str(b.notes, 2000),
          assignee === 'human' ? 'running' : 'queued', assignee, assignee === 'human' ? me.user_id : 'usr_agent_research', me.user_id, b.auto_handoff !== false] },
    ]);
    await audit(env, me.user_id, 'research.create', 'research_job', jobId, { mode, assignee });
    if (assignee === 'agent') await notify(env, ctx, 'research.job.queued', { job_id: jobId });
    return json(await getJob(env, jobId), 201);
  }
  if ((k = p.match(/^\/research\/jobs\/(rsj_[a-f0-9]+)$/)) && m === 'GET') {
    need(me, READ_ROLES);
    return json(await getJob(env, k[1]));
  }
  if ((k = p.match(/^\/research\/jobs\/(rsj_[a-f0-9]+)\/brief$/)) && m === 'PUT') {
    need(me, RESEARCH_ROLES);
    const r = await saveBrief(env, me, k[1], await body(req));
    return json({ ...r, ...(await getJob(env, k[1])) });
  }
  if ((k = p.match(/^\/research\/jobs\/(rsj_[a-f0-9]+)\/(claim|agent|cancel|handoff)$/)) && m === 'POST') {
    need(me, RESEARCH_ROLES);
    const [, id, act] = k;
    const job = await one(env, 'SELECT status, video_id FROM research_jobs WHERE id = $1', [id]);
    if (!job) throw new HttpError(404, 'job not found');
    if (act === 'handoff') return json(await handoff(env, ctx, me, id));
    if (['handed_off', 'cancelled'].includes(job.status)) throw new HttpError(409, `job is ${job.status}`);
    if (act === 'claim') {
      await q(env, `UPDATE research_jobs SET assignee_kind='human', assigned_user_id=$2, status='running', error=NULL, updated_at=now() WHERE id=$1`, [id, me.user_id]);
      await q(env, `UPDATE video_tickets SET owner_user_id=$2, updated_at=now() WHERE id=$1`, [job.video_id, me.user_id]);
    } else if (act === 'agent') {
      if (job.status === 'running' && (await one(env, `SELECT 1 FROM agent_runs WHERE job_id=$1 AND status='running'`, [id]))) throw new HttpError(409, 'agent already running');
      await q(env, `UPDATE research_jobs SET assignee_kind='agent', assigned_user_id='usr_agent_research', status='queued', error=NULL, updated_at=now() WHERE id=$1`, [id]);
      await notify(env, ctx, 'research.job.queued', { job_id: id });
    } else {
      await q(env, `UPDATE research_jobs SET status='cancelled', updated_at=now() WHERE id=$1`, [id]);
    }
    await audit(env, me.user_id, `research.${act}`, 'research_job', id, {});
    return json(await getJob(env, id));
  }

  // --- agent queue (research agent token)
  if (p === '/agent/jobs/next' && m === 'POST') {
    need(me, RESEARCH_ROLES);
    const job = await one(env, `
      UPDATE research_jobs SET status='running', started_at=now(), updated_at=now(), error=NULL
       WHERE id = (SELECT id FROM research_jobs WHERE status='queued' AND assignee_kind='agent' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`);
    if (!job) return json({ job: null });
    return json({ ...(await getJob(env, job.id)), channel: await one(env, `SELECT c.* FROM channels c JOIN research_jobs j ON j.channel_id=c.id WHERE j.id=$1`, [job.id]) });
  }
  if (p === '/agent/runs' && m === 'POST') {
    need(me, RESEARCH_ROLES);
    const b = await body(req);
    const id = newId('run');
    await q(env, `INSERT INTO agent_runs (id, job_id, agent_user_id, runtime, model) VALUES ($1,$2,$3,$4,$5)`, [id, b.job_id, me.user_id, str(b.runtime, 40) || 'pi', str(b.model, 120)]);
    return json({ id }, 201);
  }
  if ((k = p.match(/^\/agent\/runs\/(run_[a-f0-9]+)$/)) && m === 'PATCH') {
    need(me, RESEARCH_ROLES);
    const b = await body(req);
    const run = await one(env, `UPDATE agent_runs SET status=$2, input_tokens=$3, output_tokens=$4, cost_usd=$5, tool_calls=$6, log_r2_key=$7, error=$8, finished_at=now()
                                 WHERE id=$1 RETURNING job_id`, [k[1], b.status === 'succeeded' ? 'succeeded' : 'failed', b.input_tokens ?? null, b.output_tokens ?? null,
      b.cost_usd ?? null, b.tool_calls ?? null, str(b.log_r2_key, 500), str(b.error, 2000)]);
    if (!run) throw new HttpError(404, 'run not found');
    if (b.status !== 'succeeded') {
      await q(env, `UPDATE research_jobs SET status='failed', error=$2, finished_at=now(), updated_at=now() WHERE id=$1 AND status='running'`, [run.job_id, str(b.error, 2000) || 'agent run failed']);
      return json({ ok: true, job_status: 'failed' });
    }
    // Brief saved: auto hand-off when allowed and complete, otherwise wait for a human review.
    const { job, brief, facts, references } = await getJob(env, run.job_id);
    const missing = briefChecks(brief, facts, references, { auto: true });
    if (job.auto_handoff && !missing.length) {
      await q(env, `UPDATE research_jobs SET finished_at=now() WHERE id=$1`, [run.job_id]);
      return json({ ok: true, ...(await handoff(env, ctx, me, run.job_id)) });
    }
    await q(env, `UPDATE research_jobs SET status='review', finished_at=now(), updated_at=now(), error=$2 WHERE id=$1`, [run.job_id, missing.length ? `needs: ${missing.join(', ')}` : null]);
    return json({ ok: true, job_status: 'review', missing });
  }

  // --- R2 files (research/*)
  if ((k = p.match(/^\/files\/(research\/[A-Za-z0-9_\-./]+)$/))) {
    const key = k[1];
    if (key.includes('..')) throw new HttpError(400, 'bad key');
    if (m === 'PUT') {
      need(me, RESEARCH_ROLES);
      const len = +req.headers.get('Content-Length') || 0;
      if (len > 25 * 1024 * 1024) throw new HttpError(413, 'max 25 MB');
      await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: req.headers.get('Content-Type') || 'application/octet-stream' } });
      return json({ key }, 201);
    }
    if (m === 'GET') {
      need(me, READ_ROLES);
      const obj = await env.BUCKET.get(key);
      if (!obj) throw new HttpError(404, 'not found');
      return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' } });
    }
  }

  // --- admin: users + role tokens (owner/admin only)
  if (p === '/admin/users' && m === 'GET') {
    need(me, ADMIN_ROLES);
    return json({
      users: await q(env, `SELECT u.id, u.username, u.display_name, u.kind,
                                  coalesce(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
                             FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id
                            WHERE u.deleted_at IS NULL GROUP BY u.id ORDER BY u.kind, u.display_name`),
      roles: await q(env, `SELECT id, code, label FROM roles ORDER BY code`),
    });
  }
  if (p === '/admin/users' && m === 'POST') {
    need(me, ADMIN_ROLES);
    const b = await body(req);
    const username = str(b.username, 60)?.trim().toLowerCase();
    if (!username || !/^[a-z0-9._-]{2,60}$/.test(username)) throw new HttpError(400, 'username: 2-60 of a-z 0-9 . _ -');
    if (await one(env, 'SELECT 1 FROM users WHERE username=$1', [username])) throw new HttpError(409, 'username taken');
    const id = newId('usr');
    await q(env, `INSERT INTO users (id, username, display_name, password_hash, cred_status, created_at, updated_at, kind)
                  VALUES ($1,$2,$3,'!token-only','issued',now(),now(),'human')`, [id, username, str(b.display_name, 120) || username]);
    await audit(env, me.user_id, 'user.create', 'user', id, { username });
    return json({ id, username }, 201);
  }
  if (p === '/admin/tokens' && m === 'GET') {
    need(me, ADMIN_ROLES);
    return json(await q(env, `SELECT t.id, t.label, t.token_prefix, t.created_at, t.last_used_at, t.expires_at, t.revoked_at,
                                     u.id AS user_id, u.display_name, u.username, r.code AS role
                                FROM access_tokens t JOIN users u ON u.id=t.user_id JOIN roles r ON r.id=t.role_id
                               ORDER BY t.revoked_at NULLS FIRST, t.created_at DESC`));
  }
  if (p === '/admin/tokens' && m === 'POST') {
    need(me, ADMIN_ROLES);
    const b = await body(req);
    const user = await one(env, 'SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL', [b.user_id]);
    const role = await one(env, 'SELECT id, code FROM roles WHERE code=$1', [b.role]);
    if (!user || !role) throw new HttpError(400, 'user_id or role unknown');
    if (role.code === 'owner' && me.role !== 'owner') throw new HttpError(403, 'only an owner can mint owner tokens');
    const token = `ytf_${hex(24)}`;
    const id = newId('tok');
    const days = Number(b.expires_days) > 0 ? Math.min(Number(b.expires_days), 3650) : null;
    await tx(env, [
      { query: `INSERT INTO user_roles (user_id, role_id) SELECT $1::varchar, $2::varchar WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id=$1::varchar AND role_id=$2::varchar)`, params: [user.id, role.id] },
      { query: `INSERT INTO access_tokens (id, user_id, role_id, label, token_prefix, token_hash, created_by_user_id, expires_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(days => $8::int) END)`,
        params: [id, user.id, role.id, str(b.label, 120) || '', token.slice(0, 10), await sha256(token), me.user_id, days] },
    ]);
    await audit(env, me.user_id, 'token.create', 'access_token', id, { user_id: user.id, role: role.code });
    return json({ id, token, note: 'Shown once. Only its hash is stored.' }, 201);
  }
  if ((k = p.match(/^\/admin\/tokens\/(tok_[a-f0-9]+)\/revoke$/)) && m === 'POST') {
    need(me, ADMIN_ROLES);
    if (k[1] === me.token_id) throw new HttpError(409, 'you cannot revoke the token you are using');
    await q(env, 'UPDATE access_tokens SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL', [k[1]]);
    await audit(env, me.user_id, 'token.revoke', 'access_token', k[1], {});
    return json({ ok: true });
  }

  if (p === '/admin/webhook' && m === 'GET') {
    need(me, ADMIN_ROLES);
    return json({ url: env.WEBHOOK_URL || null, secret_set: !!(await loadConfig(env)).webhookSecret });
  }
  if (p === '/admin/webhook' && m === 'PUT') {
    if (me.role !== 'owner') throw new HttpError(403, 'only an owner can set the webhook secret');
    const b = await body(req);
    const secret = String(b.secret || '').trim();
    if (secret.length < 16) throw new HttpError(400, 'paste the full signing secret');
    await saveConfig(env, { webhook_secret: secret });
    await audit(env, me.user_id, 'webhook.secret.set', 'config', 'webhook', {});
    return json({ ok: true });
  }
  if (p === '/admin/webhook/test' && m === 'POST') {
    need(me, ADMIN_ROLES);
    await notify(env, ctx, 'research.job.queued', { job_id: 'rsj_0000000000000000', test: true });
    return json({ ok: true, note: 'Sent a test event; the agent finds an empty queue or runs queued jobs.' });
  }

  throw new HttpError(404, 'no such route');
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    try {
      const res = await route(req, env, ctx);
      Object.entries(h).forEach(([a, b]) => res.headers.set(a, b));
      return res;
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 && !String(e.message).startsWith('db:') ? 'server error' : e.message }, status, h);
    }
  },
};
