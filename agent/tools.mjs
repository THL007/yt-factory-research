// Research tools for the pi agent. No shell, no file access: only these.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { cfg } from './lib.mjs';

const run = promisify(execFile);
const text = (t, details = {}) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 1) }], details });

export const ytId = (url) => {
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
};

// ---- YouTube ----
async function ytSearch(query, limit) {
  const { stdout } = await run(cfg.ytdlp, ['--flat-playlist', '-J', '--no-warnings', `ytsearch${limit}:${query}`], { timeout: 60e3, maxBuffer: 20e6 });
  return (JSON.parse(stdout).entries || []).map((e) => ({
    youtube_id: e.id, url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title, channel: e.channel || e.uploader,
    views: e.view_count ?? null, duration_s: e.duration ?? null, description_snippet: (e.description || '').slice(0, 300),
  }));
}

async function ytDataApi(id) {
  if (!cfg.youtubeKey) return null;
  const u = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${id}&key=${cfg.youtubeKey}`;
  const r = await fetch(u); if (!r.ok) return null;
  const v = (await r.json()).items?.[0]; if (!v) return null;
  return { title: v.snippet.title, channel: v.snippet.channelTitle, published: v.snippet.publishedAt, description: v.snippet.description?.slice(0, 1500),
    tags: v.snippet.tags?.slice(0, 15), views: +v.statistics.viewCount || null, likes: +v.statistics.likeCount || null, comments: +v.statistics.commentCount || null,
    duration: v.contentDetails.duration };
}

async function ytVideo(url) {
  const id = ytId(url);
  if (!id) throw new Error('not a YouTube video link');
  const out = { youtube_id: id, url: `https://www.youtube.com/watch?v=${id}`, source: [] };
  const o = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(out.url)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (o) { out.title = o.title; out.channel = o.author_name; out.source.push('oembed'); }
  const d = await ytDataApi(id).catch(() => null);
  if (d) { Object.assign(out, d); out.source.push('youtube-data-api'); }
  // Same title in search gives views + duration even without the Data API.
  if (out.title && out.views == null) {
    const hit = (await ytSearch(out.title, 5).catch(() => [])).find((e) => e.youtube_id === id);
    if (hit) { out.views = hit.views; out.duration_s = hit.duration_s; out.description_snippet = hit.description_snippet; out.source.push('search'); }
  }
  out.note = 'Transcript and full page are not reachable from this server (YouTube bot check). Judge the hook from title, thumbnail, description and length; say so in the brief.';
  const img = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  return { out, img };
}

// ---- web ----
async function assertPublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('http(s) only');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address: a } of addrs) {
    if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) || a === '::1' || /^f[cd]|^fe80/i.test(a))
      throw new Error('private address blocked');
  }
}
async function fetchPage(url, find) {
  await assertPublic(url);
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (research bot)' }, signal: AbortSignal.timeout(20e3) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = (await r.text()).slice(0, 2e6);
  const title = (html.match(/<title[^>]*>([^<]*)/i) || [])[1]?.trim();
  const body = html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  if (find) {
    // Excerpts around each keyword hit, so long pages (Wikipedia, papers) reach the right section.
    const words = String(find).toLowerCase().split(/[,;]|\s+/).filter((w) => w.length > 2);
    const low = body.toLowerCase(), hits = [];
    for (const w of words) { let i = -1, n = 0; while ((i = low.indexOf(w, i + 1)) >= 0 && n++ < 4) hits.push(i); }
    hits.sort((a, b) => a - b);
    const spans = [];
    for (const h of hits) { const a = Math.max(0, h - 350), b = h + 450; if (spans.length && a <= spans.at(-1)[1]) spans.at(-1)[1] = b; else spans.push([a, b]); }
    const excerpts = spans.slice(0, 8).map(([a, b]) => '…' + body.slice(a, b) + '…');
    return { url: r.url, title, excerpts, note: excerpts.length ? undefined : 'no match; page start below', text: excerpts.length ? undefined : body.slice(0, 4000) };
  }
  return { url: r.url, title, text: body.slice(0, 7000), truncated: body.length > 7000 };
}

async function wikipedia(query) {
  const s = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': 'yt-factory-research/1.0' } }).then((r) => r.json());
  const out = [];
  for (const h of s.query?.search || []) {
    const sum = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
      { headers: { 'User-Agent': 'yt-factory-research/1.0' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    out.push({ title: h.title, url: sum?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title)}`, summary: sum?.extract || '' });
  }
  return out;
}

export function makeTools(state) {
  const tools = [
    defineTool({
      name: 'yt_search', label: 'YouTube search',
      description: 'Search YouTube. Returns title, channel, view count as shown in search, duration, link. Use for outliers/rising videos in the niche and for 3-5 competitors.',
      parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 15 })) }),
      async execute(_id, p) {
        state.toolCalls++;
        const rows = await ytSearch(p.query, Math.min(p.limit || 8, 15));
        rows.forEach((r) => state.seen.set(r.youtube_id, r));
        return text(rows);
      },
    }),
    defineTool({
      name: 'yt_video', label: 'YouTube video',
      description: 'Details of one YouTube video: title, channel, views (when available) and its thumbnail image so you can study the thumbnail and title pattern. No transcript.',
      parameters: Type.Object({ url: Type.String() }),
      async execute(_id, p) {
        state.toolCalls++;
        const { out, img } = await ytVideo(p.url);
        state.seen.set(out.youtube_id, { ...state.seen.get(out.youtube_id), ...out });
        const content = [{ type: 'text', text: JSON.stringify(out, null, 1) }];
        if (img) content.push({ type: 'image', data: Buffer.from(img).toString('base64'), mimeType: 'image/jpeg' });
        return { content, details: {} };
      },
    }),
    defineTool({
      name: 'web_search', label: 'Web search',
      description: `Search the web for facts and primary sources. Returns a short answer and source URLs; open the best URL with fetch_page to verify. Costs money: at most ${cfg.maxWebSearches} calls per job; prefer wikipedia and fetch_page first.`,
      parameters: Type.Object({ query: Type.String() }),
      async execute(_id, p) {
        state.toolCalls++;
        if (state.webSearches >= cfg.maxWebSearches) return text(`Limit reached (${cfg.maxWebSearches}). Use wikipedia or fetch_page.`);
        state.webSearches++;
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${cfg.openrouterKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, plugins: [{ id: 'web', max_results: 5 }], reasoning: { enabled: false }, usage: { include: true }, max_tokens: 1200,
            messages: [{ role: 'user', content: `Find reliable sources for: ${p.query}\nAnswer with short factual bullets, each ending with its source URL.` }] }),
        }).then((x) => x.json());
        state.extraCost += r.usage?.cost || 0;
        const msg = r.choices?.[0]?.message || {};
        const cites = (msg.annotations || []).filter((a) => a.type === 'url_citation').map((a) => ({ url: a.url_citation.url, title: a.url_citation.title }));
        for (const u of String(msg.content || '').match(/https?:\/\/[^\s)\]>"']+/g) || []) if (!cites.some((c) => c.url === u)) cites.push({ url: u.replace(/[.,;]+$/, '') });
        return text({ answer: msg.content || r.error?.message || '', sources: cites });
      },
    }),
    defineTool({
      name: 'wikipedia', label: 'Wikipedia',
      description: 'Free encyclopedia lookup: top 3 articles with summary and link. Good first stop for facts; then confirm with a primary source when you can.',
      parameters: Type.Object({ query: Type.String() }),
      async execute(_id, p) { state.toolCalls++; return text(await wikipedia(p.query)); },
    }),
    defineTool({
      name: 'fetch_page', label: 'Fetch page',
      description: 'Read a public web page to confirm a fact at its source. Pass find (keywords) to get the matching passages of a long page instead of its first ~7000 characters.',
      parameters: Type.Object({ url: Type.String(), find: Type.Optional(Type.String({ description: 'keywords, e.g. "systemic heart swimming"' })) }),
      async execute(_id, p) { state.toolCalls++; return text(await fetchPage(p.url, p.find)); },
    }),
    defineTool({
      name: 'submit_brief', label: 'Submit brief',
      description: 'Submit the finished research brief. Call once, at the end.',
      parameters: Type.Object({
        angle: Type.String({ description: 'One angle: what this video is, in one or two sentences' }),
        why_now: Type.String(), audience: Type.String(), whats_new: Type.String({ description: 'What is new vs existing videos' }),
        viral_breakdown: Type.Optional(Type.Object({
          hook: Type.String({ description: 'What stops the scroll in the first 3 s (inferred from title/thumbnail if no transcript; say so)' }),
          promise: Type.String(), structure: Type.Array(Type.String()), pacing: Type.String(), why_it_works: Type.String(), misses: Type.String(),
        })),
        remix_extra: Type.String({ description: 'The ONE clear extra that is ours, one sentence' }),
        title_ideas: Type.Array(Type.String(), { minItems: 3, maxItems: 5 }),
        facts: Type.Array(Type.Object({ claim: Type.String(), source_url: Type.String(), source_title: Type.String(), verified: Type.Boolean({ description: 'true only if you read it at the source' }) }), { minItems: 5, maxItems: 12 }),
        references: Type.Array(Type.Object({
          kind: Type.Union([Type.Literal('seed'), Type.Literal('competitor')]), url: Type.String(), title: Type.String(), channel_name: Type.String(),
          views_seen: Type.Optional(Type.Number({ description: 'Only a number a tool returned; omit otherwise' })), duration_s: Type.Optional(Type.Number()),
          notes: Type.String({ description: 'Seed: why it works. Competitor: what it misses' }),
        }), { minItems: 3, maxItems: 8 }),
        asset_notes: Type.Array(Type.Object({ need: Type.String(), source: Type.String(), license: Type.String(), rights_risk: Type.String() })),
        rights_flags: Type.Array(Type.String()),
      }),
      async execute(_id, p) {
        state.brief = p;
        return { content: [{ type: 'text', text: 'Brief received.' }], details: {}, terminate: true };
      },
    }),
  ];
  return tools;
}
