// Client for yt-factory-api (Cloudflare Worker → Neon + R2). The token stays in this browser only.
export const DEFAULT_API = "https://yt-factory-api.thl007.workers.dev";

export type Role = "owner" | "admin" | "research" | "content" | "production" | "publish" | string;
export type JobStatus = "queued" | "running" | "review" | "handed_off" | "failed" | "cancelled";
export type Job = {
  id: string; mode: "topic" | "viral_breakdown"; seed_topic: string | null; seed_video_url: string | null; status: JobStatus;
  assignee_kind: "agent" | "human"; auto_handoff: boolean; created_at: string; updated_at: string; finished_at: string | null; error: string | null;
  video_id: string; channel_id: string; channel_name: string; title_working: string; stage: string; assigned_name: string | null; angle: string | null;
};
export type ViralBreakdown = { hook: string; promise: string; structure: string[]; pacing: string; why_it_works: string; misses: string };
export type AssetNote = { need: string; source: string; license: string; rights_risk: string };
export type Brief = {
  id: string; version: number; angle: string | null; why_now: string | null; audience: string | null; whats_new: string | null;
  viral_breakdown: ViralBreakdown | null; remix_extra: string | null; title_ideas: string[]; asset_notes: AssetNote[]; rights_flags: string[];
  author_kind: "agent" | "human"; r2_key: string | null; created_at: string;
};
export type Fact = { id?: string; claim: string; source_url: string | null; source_title: string | null; verified: boolean };
export type Reference = {
  id?: string; kind: "seed" | "competitor"; youtube_id?: string | null; url: string; title: string | null; channel_name: string | null;
  views_seen: number | null; duration_s: number | null; notes: string | null; thumbnail_r2_key?: string | null;
};
export type Run = { id: string; model: string; status: string; input_tokens: number | null; output_tokens: number | null; cost_usd: string | null; tool_calls: number | null; error: string | null; started_at: string; finished_at: string | null };
export type JobDetail = { job: Job; brief: Brief | null; facts: Fact[]; references: Reference[]; runs: Run[] };
export type Channel = { id: string; name: string; niche: string | null; language: string | null; status: string };
export type Me = { user: { id: string; username: string; display_name: string; kind: string }; role: Role; token_label: string };

const KEY = "ytf-research";
export function getSettings(): { api: string; token: string } {
  if (typeof localStorage === "undefined") return { api: DEFAULT_API, token: "" };
  try { return { api: DEFAULT_API, token: "", ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { api: DEFAULT_API, token: "" }; }
}
export function saveSettings(s: { api: string; token: string }) { localStorage.setItem(KEY, JSON.stringify(s)); }
export function signOut() { localStorage.removeItem(KEY); }

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function call<T>(path: string, init: RequestInit = {}, s = getSettings()): Promise<T> {
  let res: Response;
  try {
    res = await fetch(s.api.replace(/\/$/, "") + path, {
      ...init,
      headers: { Authorization: `Bearer ${s.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
    });
  } catch {
    throw new ApiError(0, "Can’t reach the factory API. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}
const post = <T>(p: string, b?: unknown) => call<T>(p, { method: "POST", body: b === undefined ? undefined : JSON.stringify(b) });

export const api = {
  me: (s?: { api: string; token: string }) => call<Me>("/me", {}, s),
  channels: () => call<Channel[]>("/channels"),
  jobs: (status?: string) => call<Job[]>(`/research/jobs${status ? `?status=${status}` : ""}`),
  job: (id: string) => call<JobDetail>(`/research/jobs/${id}`),
  createJob: (b: { channel_id: string; mode: string; seed_topic?: string; seed_video_url?: string; notes?: string; assignee_kind: string; auto_handoff: boolean }) =>
    post<JobDetail>("/research/jobs", b),
  saveBrief: (id: string, b: unknown) => call<JobDetail & { version: number }>(`/research/jobs/${id}/brief`, { method: "PUT", body: JSON.stringify(b) }),
  action: (id: string, act: "claim" | "agent" | "cancel" | "handoff") => post<JobDetail | { ok: boolean }>(`/research/jobs/${id}/${act}`),
  webhook: () => call<{ url: string | null; secret_set: boolean }>("/admin/webhook"),
  setWebhookSecret: (secret: string) => call<{ ok: boolean }>("/admin/webhook", { method: "PUT", body: JSON.stringify({ secret }) }),
  testWebhook: () => post<{ ok: boolean; note: string }>("/admin/webhook/test"),
  /** R2 file through the API (auth header), as an object URL for <img>. */
  async fileUrl(key: string) {
    const s = getSettings();
    const r = await fetch(`${s.api.replace(/\/$/, "")}/files/${key}`, { headers: { Authorization: `Bearer ${s.token}` } });
    if (!r.ok) throw new ApiError(r.status, "file");
    return URL.createObjectURL(await r.blob());
  },
};

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued", running: "Researching", review: "Needs review", handed_off: "In Script", failed: "Failed", cancelled: "Cancelled",
};
export const isAdmin = (r?: Role) => r === "owner" || r === "admin";
export const canResearch = (r?: Role) => r === "owner" || r === "admin" || r === "research";
export function ago(iso?: string | null) {
  if (!iso) return "";
  const t = new Date(iso.replace(" ", "T").replace(/\+00$/, "Z")).getTime();
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export const fmtViews = (n: number | string | null) => (n == null || n === "" ? "TBD" : Number(n).toLocaleString("en-US"));
