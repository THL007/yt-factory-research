// Mirror a research job into the Obsidian hub: video ticket note + board link.
// Neon is the source of truth for data; the vault note is the human-readable copy.
// Usage: node mirror.mjs <rsj_id>
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { api, cfg, slugify } from './lib.mjs';

const STAGE_HEADINGS = { idea: '## Idea', script: '## Script', assets: '## Assets', edit: '## Edit', qa: '## QA', upload: '## Upload queue', published: '## Published' };

function findNote(dir, videoId) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    if (readFileSync(join(dir, f), 'utf8').includes(`db_video_id: ${videoId}`)) return f;
  }
  return null;
}

const esc = (s) => String(s ?? '').replace(/\r?\n/g, ' ').trim();

export function briefMarkdown({ job, brief, facts, references }) {
  if (!brief) return '_No brief yet._\n';
  const vb = brief.viral_breakdown;
  const L = [];
  L.push(`- **Angle:** ${esc(brief.angle)}`, `- **Why now:** ${esc(brief.why_now)}`, `- **For:** ${esc(brief.audience)}`, `- **New vs existing:** ${esc(brief.whats_new)}`);
  L.push(`- **Remix + extra:** ${esc(brief.remix_extra)}`, `- **Brief:** v${brief.version} by ${brief.author_kind}`, '');
  if (vb) {
    L.push('### Viral breakdown', `- Hook: ${esc(vb.hook)}`, `- Promise: ${esc(vb.promise)}`, `- Structure: ${(vb.structure || []).map(esc).join(' → ')}`,
      `- Pacing / CTA: ${esc(vb.pacing)}`, `- Why it works: ${esc(vb.why_it_works)}`, `- Misses: ${esc(vb.misses)}`, '');
  }
  L.push('### Facts + sources');
  facts.forEach((f, i) => L.push(`${i + 1}. ${esc(f.claim)} — [${esc(f.source_title) || 'source'}](${f.source_url || ''})${f.verified ? '' : ' `UNVERIFIED`'}`));
  L.push('', '### Reference videos', '| Kind | Video | Channel | Views seen | Notes |', '|---|---|---|---|---|');
  references.forEach((r) => L.push(`| ${r.kind} | [${esc(r.title).replace(/\|/g, '/')}](${r.url}) | ${esc(r.channel_name)} | ${r.views_seen ?? 'TBD'} | ${esc(r.notes).replace(/\|/g, '/')} |`));
  L.push('', '### Title ideas');
  (brief.title_ideas || []).forEach((t, i) => L.push(`${i + 1}. ${esc(t)}`));
  L.push('', '### Assets + rights');
  (brief.asset_notes || []).forEach((a) => L.push(`- ${esc(a.need)} — ${esc(a.source)} (${esc(a.license)}); risk: ${esc(a.rights_risk)}`));
  (brief.rights_flags || []).forEach((f) => L.push(`- ⚠ ${esc(f)}`));
  return L.join('\n') + '\n';
}

export async function mirror(jobId) {
  const d = await api(`/research/jobs/${jobId}`);
  const { job } = d;
  const dir = join(cfg.vault, 'videos');
  const today = new Date().toISOString().slice(0, 10);
  let file = findNote(dir, job.video_id);
  const title = job.title_working;
  if (!file) file = `${(job.created_at || today).slice(0, 10)}-${slugify(title)}.md`;
  const path = join(dir, file);
  const section = `## Research brief\n<!-- written by the research pipeline (job ${job.id}); edit in the Research app -->\n${briefMarkdown(d)}`;
  let note;
  if (existsSync(path)) {
    note = readFileSync(path, 'utf8')
      .replace(/^stage: .*$/m, `stage: ${job.stage}`)
      .replace(/^owner: .*$/m, `owner: "${job.stage === 'script' ? '' : job.assigned_name || ''}"`)
      .replace(/^- Niche angle:.*$/m, `- Niche angle: ${d.brief?.angle ? esc(d.brief.angle) : ''}`)
      .replace(/^updated: .*$/m, `updated: ${today}`);
    note = /## Research brief[\s\S]*?(?=\n## (?!#)|$)/.test(note)
      ? note.replace(/## Research brief[\s\S]*?(?=\n## (?!#)|$)/, section.trimEnd() + '\n')
      : note.replace(/\n## Meta/, `\n${section}\n## Meta`);
  } else {
    const tpl = readFileSync(join(dir, '_TEMPLATE.md'), 'utf8');
    note = tpl
      .replace('channel: ""', `channel: "${job.channel_name}"`)
      .replace('stage: idea', `stage: ${job.stage}`)
      .replace('owner: ""', `owner: "${job.stage === 'script' ? '' : job.assigned_name || ''}"`)
      .replace('title_working: ""', `title_working: "${title.replace(/"/g, "'")}"`)
      .replace(/^created: *$/m, `created: ${today}`)
      .replace(/^updated: *$/m, `updated: ${today}\ndb_video_id: ${job.video_id}\nresearch_job: ${job.id}`)
      .replace('# <title working>', `# ${title}`)
      .replace('- Channel:', `- Channel: ${job.channel_name}`)
      .replace('- Niche angle:', `- Niche angle: ${d.brief?.angle ? esc(d.brief.angle) : ''}`)
      .replace('\n## Meta', `\n${section}\n## Meta`);
  }
  writeFileSync(path, note);

  // Board: one link per video, under its stage.
  const boardPath = join(cfg.vault, 'pipeline/board.md');
  const link = `[[videos/${file.replace(/\.md$/, '')}\\|${title.replace(/[|\]]/g, '/')}]]`;
  let lines = readFileSync(boardPath, 'utf8').split('\n').filter((l) => !l.includes(`videos/${file.replace(/\.md$/, '')}`));
  const head = STAGE_HEADINGS[job.status === 'cancelled' ? 'idea' : job.stage] || '## Idea';
  const at = lines.findIndex((l) => l.startsWith(head));
  if (job.status !== 'cancelled' && at >= 0) {
    if (lines[at + 1]?.trim() === '-') lines.splice(at + 1, 1);
    lines.splice(at + 1, 0, `- ${link}${job.stage === 'idea' ? ` · research ${job.status}` : ''}`);
  }
  // Keep an empty "-" under headings that lost their last card.
  lines = lines.flatMap((l, i) => (l.startsWith('## ') && (lines[i + 1] === '' || lines[i + 1]?.startsWith('## ') || i === lines.length - 1) && !l.startsWith('## Blocked') ? [l, '-'] : [l]));
  writeFileSync(boardPath, lines.join('\n').replace(/^updated: .*$/m, `updated: ${today}`));
  return { note: path, stage: job.stage };
}

if (process.argv[1]?.endsWith('mirror.mjs')) {
  const id = process.argv[2];
  if (!/^rsj_[a-f0-9]+$/.test(id || '')) { console.error('usage: node mirror.mjs <rsj_id>'); process.exit(2); }
  console.log(JSON.stringify(await mirror(id)));
}
