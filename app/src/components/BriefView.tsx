import { useCallback, useEffect, useState } from "react";
import { ago, api, AssetNote, canResearch, Fact, fmtViews, JobDetail, Me, Reference, STATUS_LABEL, ViralBreakdown } from "../lib/api";

const dur = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);

export function missingForHandoff(d: JobDetail) {
  const m: string[] = [];
  const sourced = d.facts.filter((f) => /^https?:\/\//.test(f.source_url || ""));
  if (!d.brief?.angle) m.push("an angle");
  if (sourced.length < 5) m.push(`${5 - sourced.length} more sourced fact${5 - sourced.length === 1 ? "" : "s"}`);
  const comp = d.references.filter((r) => r.kind === "competitor").length;
  if (comp < 3) m.push(`${3 - comp} more competitor video${3 - comp === 1 ? "" : "s"}`);
  return m;
}

function Thumb({ r }: { r: Reference }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    if (r.thumbnail_r2_key) api.fileUrl(r.thumbnail_r2_key).then((u) => { url = u; setSrc(u); }).catch(() => setSrc(null));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [r.thumbnail_r2_key]);
  return <span className="thumb">{src ? <img src={src} alt="" loading="lazy" /> : null}</span>;
}

export function BriefView({ id, me, onBack }: { id: string; me: Me; onBack: () => void }) {
  const [d, setD] = useState<JobDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try { setD(await api.job(id)); setError(""); } catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!d || !["queued", "running"].includes(d.job.status) || d.job.assignee_kind !== "agent") return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [d, load]);

  async function act(a: "claim" | "agent" | "cancel" | "handoff") {
    if (a === "cancel" && !window.confirm("Cancel this research job? The video ticket stays in Idea.")) return;
    setBusy(a); setActionError("");
    try { await api.action(id, a); await load(); } catch (e: any) { setActionError(e.message); } finally { setBusy(null); }
  }

  if (error) return (
    <section className="page"><div className="notice notice--error" role="alert"><p>Couldn’t open this job: {error}</p>
      <div className="row-gap"><button type="button" className="btn" onClick={load}>Try again</button><button type="button" className="btn" onClick={onBack}>Back to queue</button></div></div></section>
  );
  if (!d) return (
    <section className="page" aria-busy="true"><div className="page__head"><span className="skel skel--head" /></div>
      <div className="sheet">{[0, 1, 2, 3, 4].map((i) => <span key={i} className="skel skel--line" style={{ width: `${88 - i * 9}%`, margin: "0.9rem 0" }} />)}</div></section>
  );

  const { job, brief, facts, references, runs } = d;
  const open = !["handed_off", "cancelled"].includes(job.status);
  const missing = missingForHandoff(d);
  const may = canResearch(me.role);
  const agentBusy = job.assignee_kind === "agent" && ["queued", "running"].includes(job.status);
  const verified = facts.filter((f) => f.verified).length;

  if (editing) return <BriefEditor d={d} onCancel={() => setEditing(false)} onSaved={(nd) => { setD(nd); setEditing(false); }} />;

  return (
    <article className="page">
      <button type="button" className="link-btn back" onClick={onBack}>Back to queue</button>
      <header className="page__head page__head--job">
        <div>
          <h1 className="page__title">{job.title_working}</h1>
          <p className="page__meta">{job.channel_name}. {job.mode === "viral_breakdown" ? "Viral breakdown" : "Topic research"}. Ticket in <strong>{job.stage === "script" ? "Script" : "Idea"}</strong>.</p>
          <p className="page__status"><span className={`status status--${job.status}`}>{STATUS_LABEL[job.status]}</span>
            {job.assignee_kind === "agent" ? " Research agent" : job.assigned_name ? ` ${job.assigned_name}` : ""}{brief ? `. Brief v${brief.version} by ${brief.author_kind === "agent" ? "the agent" : "a person"}, ${ago(brief.created_at)}.` : "."}</p>
        </div>
        {may && open && (
          <div className="actions">
            {brief && <button type="button" className="btn btn--primary" disabled={!!busy || missing.length > 0 || agentBusy} aria-busy={busy === "handoff"} onClick={() => act("handoff")}>{busy === "handoff" ? "Handing off…" : "Hand off to Script"}</button>}
            {!agentBusy && <button type="button" className="btn" disabled={!!busy} onClick={() => setEditing(true)}>{brief ? "Edit brief" : "Write brief"}</button>}
            {!agentBusy && <button type="button" className="btn" disabled={!!busy} aria-busy={busy === "agent"} onClick={() => act("agent")}>{brief ? "Ask agent to redo" : "Give to agent"}</button>}
            {job.assignee_kind === "agent" && job.status !== "running" && <button type="button" className="btn" disabled={!!busy} onClick={() => act("claim")}>Claim it</button>}
            <button type="button" className="link-btn" disabled={!!busy} onClick={() => act("cancel")}>Cancel job</button>
          </div>
        )}
      </header>
      {actionError && <div className="notice notice--error" role="alert"><p>{actionError}</p></div>}
      {open && brief && missing.length > 0 && <div className="notice"><p>Before hand-off this brief needs {missing.join(", ")}.</p></div>}
      {job.status === "failed" && <div className="notice notice--error"><p>The last agent run failed: {job.error || "no reason given"}. Ask the agent to redo it or claim the job.</p></div>}
      {job.status === "review" && job.error && <div className="notice"><p>The agent stopped short of hand-off: {job.error.replace(/^needs: /, "it still needs ")}.</p></div>}

      {!brief && (
        <div className="sheet empty">
          {agentBusy ? (<><p className="empty__title">{job.status === "queued" ? "Waiting for the research agent." : "The agent is researching."}</p><p>It searches YouTube and the web, checks facts at the source and files the brief here. This page updates by itself.</p><span className="progress" aria-hidden="true" /></>)
            : (<><p className="empty__title">No brief yet.</p><p>Write it yourself or give it to the agent.</p></>)}
        </div>
      )}

      {brief && (
        <>
          <section className="sheet dossier">
            <h2 className="sheet__head">Angle</h2>
            <p className="angle">{brief.angle}</p>
            <dl className="defs">
              <div><dt>Why now</dt><dd>{brief.why_now}</dd></div>
              <div><dt>Who it is for</dt><dd>{brief.audience}</dd></div>
              <div><dt>New compared with what exists</dt><dd>{brief.whats_new}</dd></div>
              <div className="defs__mark"><dt>Remix + our one extra</dt><dd>{brief.remix_extra}</dd></div>
            </dl>
          </section>

          {brief.viral_breakdown && (
            <section className="sheet">
              <h2 className="sheet__head">Viral breakdown</h2>
              <dl className="defs defs--two">
                <div><dt>Hook, first 3 seconds</dt><dd>{brief.viral_breakdown.hook}</dd></div>
                <div><dt>Promise</dt><dd>{brief.viral_breakdown.promise}</dd></div>
                <div><dt>Pacing and call to action</dt><dd>{brief.viral_breakdown.pacing}</dd></div>
                <div><dt>Why it works</dt><dd>{brief.viral_breakdown.why_it_works}</dd></div>
                <div><dt>What it misses</dt><dd>{brief.viral_breakdown.misses}</dd></div>
              </dl>
              <ol className="beats">{brief.viral_breakdown.structure.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </section>
          )}

          <section className="sheet">
            <div className="sheet__headrow"><h2 className="sheet__head">Facts and sources</h2><p className="tally"><span className="num">{verified}</span> of <span className="num">{facts.length}</span> checked at the source</p></div>
            <table className="table ledger">
              <thead><tr><th scope="col" className="num">No.</th><th scope="col">Claim</th><th scope="col">Source</th><th scope="col">Check</th></tr></thead>
              <tbody>
                {facts.map((f, i) => (
                  <tr key={f.id || i}>
                    <td className="num">{i + 1}</td>
                    <td>{f.claim}</td>
                    <td>{f.source_url ? <a href={f.source_url} target="_blank" rel="noopener noreferrer">{f.source_title || new URL(f.source_url).hostname}</a> : <span className="muted">No source</span>}</td>
                    <td>{f.verified ? <span className="check-ok">Checked</span> : <span className="flag">UNVERIFIED</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="sheet">
            <h2 className="sheet__head">Reference videos</h2>
            <table className="table refs">
              <thead><tr><th scope="col">Video</th><th scope="col" className="hide-s">Role</th><th scope="col" className="num">Views seen</th><th scope="col" className="num hide-s">Length</th></tr></thead>
              <tbody>
                {references.map((r, i) => (
                  <tr key={r.id || i}>
                    <td>
                      <div className="ref">
                        <Thumb r={r} />
                        <div><a href={r.url} target="_blank" rel="noopener noreferrer">{r.title || r.url}</a><span className="row-sub">{r.channel_name}</span><span className="ref__note">{r.notes}</span></div>
                      </div>
                    </td>
                    <td className="hide-s">{r.kind === "seed" ? "Seed" : "Competitor"}</td>
                    <td className="num">{fmtViews(r.views_seen)}</td>
                    <td className="num hide-s">{dur(r.duration_s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fine">Views are the numbers YouTube search showed when the brief was made. TBD means not seen.</p>
          </section>

          <div className="split">
            <section className="sheet">
              <h2 className="sheet__head">Title ideas</h2>
              <ol className="titles">{brief.title_ideas.map((t, i) => <li key={i}>{t}</li>)}</ol>
            </section>
            <section className="sheet">
              <h2 className="sheet__head">Assets and rights</h2>
              <ul className="assets">
                {brief.asset_notes.map((a, i) => <li key={i}><strong>{a.need}</strong><span>{a.source}. {a.license}.</span><span className="risk">Risk: {a.rights_risk}</span></li>)}
              </ul>
              {brief.rights_flags.length > 0 && <ul className="flags">{brief.rights_flags.map((f, i) => <li key={i}>{f}</li>)}</ul>}
            </section>
          </div>
        </>
      )}

      {runs.length > 0 && (
        <section className="sheet">
          <h2 className="sheet__head">Agent runs</h2>
          <table className="table">
            <thead><tr><th scope="col">Model</th><th scope="col">Result</th><th scope="col" className="num">Tool calls</th><th scope="col" className="num hide-s">Tokens in / out</th><th scope="col" className="num">Cost, USD</th><th scope="col" className="num hide-s">Started</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="mono-s">{r.model.replace(/^openrouter\//, "")}</td>
                  <td>{r.status === "succeeded" ? "Done" : r.status === "running" ? "Running" : <span className="flag">Failed</span>}</td>
                  <td className="num">{r.tool_calls ?? ""}</td>
                  <td className="num hide-s">{r.input_tokens != null ? `${Number(r.input_tokens).toLocaleString("en-US")} / ${Number(r.output_tokens ?? 0).toLocaleString("en-US")}` : ""}</td>
                  <td className="num">{r.cost_usd != null ? Number(r.cost_usd).toFixed(4) : ""}</td>
                  <td className="num hide-s">{ago(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </article>
  );
}

// ---------- editor ----------
const emptyVB: ViralBreakdown = { hook: "", promise: "", structure: [], pacing: "", why_it_works: "", misses: "" };

function BriefEditor({ d, onCancel, onSaved }: { d: JobDetail; onCancel: () => void; onSaved: (d: JobDetail) => void }) {
  const b = d.brief;
  const [f, setF] = useState({
    angle: b?.angle || "", why_now: b?.why_now || "", audience: b?.audience || "", whats_new: b?.whats_new || "", remix_extra: b?.remix_extra || "",
    titles: (b?.title_ideas || []).join("\n"), flags: (b?.rights_flags || []).join("\n"),
  });
  const [useVB, setUseVB] = useState(!!b?.viral_breakdown || d.job.mode === "viral_breakdown");
  const [vb, setVB] = useState<ViralBreakdown>(b?.viral_breakdown || emptyVB);
  const [facts, setFacts] = useState<Fact[]>(d.facts.length ? d.facts.map((x) => ({ ...x })) : [{ claim: "", source_url: "", source_title: "", verified: false }]);
  const [refs, setRefs] = useState<Reference[]>(d.references.map((x) => ({ ...x })));
  const [assets, setAssets] = useState<AssetNote[]>(b?.asset_notes || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const upd = <T,>(arr: T[], setArr: (v: T[]) => void, i: number, patch: Partial<T>) => setArr(arr.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    if (!f.angle.trim()) { setError("The angle is required."); return; }
    setBusy(true); setError("");
    try {
      const nd = await api.saveBrief(d.job.id, {
        angle: f.angle, why_now: f.why_now, audience: f.audience, whats_new: f.whats_new, remix_extra: f.remix_extra,
        viral_breakdown: useVB ? vb : null,
        title_ideas: f.titles.split("\n").map((s) => s.trim()).filter(Boolean),
        rights_flags: f.flags.split("\n").map((s) => s.trim()).filter(Boolean),
        facts: facts.filter((x) => x.claim.trim()),
        references: refs.filter((x) => x.url.trim()),
        asset_notes: assets.filter((x) => x.need.trim()),
      });
      onSaved(nd);
    } catch (e: any) { setError(e.message); setBusy(false); }
  }

  return (
    <article className="page">
      <header className="page__head">
        <div><h1 className="page__title">{b ? "Edit brief" : "Write brief"}: {d.job.title_working}</h1><p className="page__meta">{d.job.channel_name}. Saving makes brief v{(b?.version || 0) + 1}; older versions stay in the database.</p></div>
        <div className="actions"><button type="button" className="btn btn--primary" onClick={save} disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save brief"}</button><button type="button" className="btn" onClick={onCancel} disabled={busy}>Discard changes</button></div>
      </header>
      {error && <div className="notice notice--error" role="alert"><p>{error}</p></div>}

      <section className="sheet form">
        <h2 className="sheet__head">Angle</h2>
        <label className="field"><span className="field__label">Angle, one or two sentences</span><textarea className="input input--area" rows={2} value={f.angle} onChange={set("angle")} /></label>
        <label className="field"><span className="field__label">Why now</span><textarea className="input input--area" rows={2} value={f.why_now} onChange={set("why_now")} /></label>
        <label className="field"><span className="field__label">Who it is for</span><input className="input" value={f.audience} onChange={set("audience")} /></label>
        <label className="field"><span className="field__label">New compared with existing videos</span><textarea className="input input--area" rows={2} value={f.whats_new} onChange={set("whats_new")} /></label>
        <label className="field"><span className="field__label">Remix + our one extra, one sentence</span><input className="input" value={f.remix_extra} onChange={set("remix_extra")} /></label>
      </section>

      <section className="sheet form">
        <div className="sheet__headrow"><h2 className="sheet__head">Viral breakdown</h2><label className="check"><input type="checkbox" checked={useVB} onChange={(e) => setUseVB(e.target.checked)} /><span>A hit video is the seed</span></label></div>
        {useVB && (
          <>
            {(["hook", "promise", "pacing", "why_it_works", "misses"] as const).map((k) => (
              <label key={k} className="field"><span className="field__label">{{ hook: "Hook, first 3 seconds", promise: "Promise or title pattern", pacing: "Pacing and call to action", why_it_works: "Why it works", misses: "What it misses" }[k]}</span>
                <textarea className="input input--area" rows={2} value={vb[k]} onChange={(e) => setVB({ ...vb, [k]: e.target.value })} /></label>
            ))}
            <label className="field"><span className="field__label">Structure, one beat per line</span><textarea className="input input--area" rows={4} value={vb.structure.join("\n")} onChange={(e) => setVB({ ...vb, structure: e.target.value.split("\n") })} /></label>
          </>
        )}
      </section>

      <section className="sheet form">
        <h2 className="sheet__head">Facts and sources</h2>
        {facts.map((x, i) => (
          <div key={i} className="editrow">
            <span className="num editrow__n">{i + 1}</span>
            <div className="editrow__body">
              <textarea className="input input--area" rows={2} aria-label={`Claim ${i + 1}`} value={x.claim} onChange={(e) => upd(facts, setFacts, i, { claim: e.target.value })} placeholder="Claim" />
              <div className="editrow__line">
                <input className="input input--mono" aria-label={`Source link ${i + 1}`} value={x.source_url || ""} onChange={(e) => upd(facts, setFacts, i, { source_url: e.target.value })} placeholder="https://source" />
                <input className="input" aria-label={`Source title ${i + 1}`} value={x.source_title || ""} onChange={(e) => upd(facts, setFacts, i, { source_title: e.target.value })} placeholder="Source title" />
              </div>
              <div className="editrow__line">
                <label className="check"><input type="checkbox" checked={x.verified} onChange={(e) => upd(facts, setFacts, i, { verified: e.target.checked })} /><span>I read it at the source</span></label>
                <button type="button" className="link-btn" onClick={() => setFacts(facts.filter((_, j) => j !== i))}>Remove</button>
              </div>
            </div>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setFacts([...facts, { claim: "", source_url: "", source_title: "", verified: false }])}>Add fact</button>
      </section>

      <section className="sheet form">
        <h2 className="sheet__head">Reference videos</h2>
        {refs.map((r, i) => (
          <div key={i} className="editrow">
            <span className="num editrow__n">{i + 1}</span>
            <div className="editrow__body">
              <div className="editrow__line">
                <input className="input input--mono" aria-label={`Video link ${i + 1}`} value={r.url} onChange={(e) => upd(refs, setRefs, i, { url: e.target.value })} placeholder="https://www.youtube.com/watch?v=…" />
                <select className="input" aria-label={`Role ${i + 1}`} value={r.kind} onChange={(e) => upd(refs, setRefs, i, { kind: e.target.value as Reference["kind"] })}><option value="competitor">Competitor</option><option value="seed">Seed</option></select>
              </div>
              <div className="editrow__line">
                <input className="input" aria-label={`Title ${i + 1}`} value={r.title || ""} onChange={(e) => upd(refs, setRefs, i, { title: e.target.value })} placeholder="Title" />
                <input className="input" aria-label={`Channel ${i + 1}`} value={r.channel_name || ""} onChange={(e) => upd(refs, setRefs, i, { channel_name: e.target.value })} placeholder="Channel" />
                <input className="input input--mono input--s" aria-label={`Views seen ${i + 1}`} inputMode="numeric" value={r.views_seen ?? ""} onChange={(e) => upd(refs, setRefs, i, { views_seen: e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")) })} placeholder="Views seen" />
              </div>
              <textarea className="input input--area" rows={2} aria-label={`Notes ${i + 1}`} value={r.notes || ""} onChange={(e) => upd(refs, setRefs, i, { notes: e.target.value })} placeholder={r.kind === "seed" ? "Why it works" : "What it misses"} />
              <div className="editrow__line"><span /><button type="button" className="link-btn" onClick={() => setRefs(refs.filter((_, j) => j !== i))}>Remove</button></div>
            </div>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setRefs([...refs, { kind: "competitor", url: "", title: "", channel_name: "", views_seen: null, duration_s: null, notes: "" }])}>Add video</button>
      </section>

      <section className="sheet form">
        <h2 className="sheet__head">Titles, assets and rights</h2>
        <label className="field"><span className="field__label">Title ideas, one per line</span><textarea className="input input--area" rows={4} value={f.titles} onChange={set("titles")} /></label>
        {assets.map((a, i) => (
          <div key={i} className="editrow__line editrow__line--wrap">
            <input className="input" aria-label="Asset needed" value={a.need} onChange={(e) => upd(assets, setAssets, i, { need: e.target.value })} placeholder="Asset needed" />
            <input className="input" aria-label="Source" value={a.source} onChange={(e) => upd(assets, setAssets, i, { source: e.target.value })} placeholder="Source" />
            <input className="input" aria-label="Licence" value={a.license} onChange={(e) => upd(assets, setAssets, i, { license: e.target.value })} placeholder="Licence" />
            <input className="input" aria-label="Rights risk" value={a.rights_risk} onChange={(e) => upd(assets, setAssets, i, { rights_risk: e.target.value })} placeholder="Rights risk" />
            <button type="button" className="link-btn" onClick={() => setAssets(assets.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setAssets([...assets, { need: "", source: "", license: "", rights_risk: "" }])}>Add asset</button>
        <label className="field"><span className="field__label">Rights flags, one per line</span><textarea className="input input--area" rows={3} value={f.flags} onChange={set("flags")} /></label>
      </section>

      <div className="form__actions form__actions--end"><button type="button" className="btn btn--primary" onClick={save} disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save brief"}</button><button type="button" className="btn" onClick={onCancel} disabled={busy}>Discard changes</button></div>
    </article>
  );
}
