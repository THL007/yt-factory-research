// Shared config + API client for the research agent.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));

// .env next to this file (never committed): YTF_API, YTF_AGENT_TOKEN, OPENROUTER_API_KEY_FILE, ...
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const fromFile = (name) => {
  if (process.env[name]) return process.env[name];
  const f = process.env[`${name}_FILE`];
  return f && existsSync(f) ? readFileSync(f, 'utf8').trim() : undefined;
};

export const cfg = {
  api: (process.env.YTF_API || 'https://yt-factory-api.thl007.workers.dev').replace(/\/$/, ''),
  token: fromFile('YTF_AGENT_TOKEN'),
  openrouterKey: fromFile('OPENROUTER_API_KEY'),
  youtubeKey: fromFile('YOUTUBE_API_KEY'), // optional: YouTube Data API v3 for real view/like counts
  model: process.env.YTF_MODEL || 'anthropic/claude-haiku-5.5',
  thinking: process.env.YTF_THINKING || 'low',
  maxWebSearches: +(process.env.YTF_MAX_WEB_SEARCHES || 4),
  vault: process.env.YTF_VAULT || '/home/obsidian/yt-factory',
  ytdlp: process.env.YTF_YTDLP || join(ROOT, '.venv/bin/yt-dlp'),
};

export async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(cfg.api + path, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body == null ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error || text.slice(0, 200)}`);
  return data;
}

export const putFile = (key, bytes, contentType) =>
  api(`/files/${key}`, { method: 'PUT', body: bytes, raw: true, headers: { 'Content-Type': contentType } });

export const slugify = (s) => String(s || 'video').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
  .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'video';
