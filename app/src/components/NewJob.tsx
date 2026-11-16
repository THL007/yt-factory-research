import { FormEvent, useEffect, useState } from "react";
import { api, canResearch, Channel, Me } from "../lib/api";

export function NewJob({ me, onCreated }: { me: Me; onCreated: (id: string) => void }) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<"topic" | "viral_breakdown">("topic");
  const [channel, setChannel] = useState("");
  const [topic, setTopic] = useState("");
  const [video, setVideo] = useState("");
  const [notes, setNotes] = useState("");
  const [who, setWho] = useState<"agent" | "human">("agent");
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadChannels = () => {
    setLoadError("");
    api.channels().then((c) => { setChannels(c); if (c.length === 1) setChannel(c[0].id); }).catch((e) => setLoadError(e.message));
  };
  useEffect(loadChannels, []);

  if (!canResearch(me.role)) {
    return <section className="page"><div className="notice"><p>Your role ({me.role}) can read briefs but not start research. Ask the owner for a research token.</p></div></section>;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!channel) return setError("Pick a channel.");
    if (mode === "topic" && !topic.trim()) return setError("Write the topic to research.");
    if (mode === "viral_breakdown" && !/^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(video.trim())) return setError("Paste a YouTube link to the hit video.");
    setBusy(true); setError("");
    try {
      const d = await api.createJob({ channel_id: channel, mode, seed_topic: topic.trim() || undefined, seed_video_url: video.trim() || undefined, notes: notes.trim() || undefined, assignee_kind: who, auto_handoff: auto });
      onCreated(d.job.id);
    } catch (err: any) { setError(err.message); setBusy(false); }
  }

  return (
    <section className="page page--narrow">
      <div className="page__head">
        <div>
          <h1 className="page__title">New research job</h1>
          <p className="page__lede">Creates the video ticket in Idea and queues the research.</p>
        </div>
      </div>

      <form className="sheet form" onSubmit={submit} noValidate>
        <fieldset className="field">
          <legend className="field__label">Start from</legend>
          <div className="segmented">
            <label className="segmented__opt"><input type="radio" name="mode" checked={mode === "topic"} onChange={() => setMode("topic")} /><span>A topic</span></label>
            <label className="segmented__opt"><input type="radio" name="mode" checked={mode === "viral_breakdown"} onChange={() => setMode("viral_breakdown")} /><span>A hit video (viral breakdown)</span></label>
          </div>
        </fieldset>

        <label className="field">
          <span className="field__label">Channel</span>
          {channels === null && !loadError && <span className="skel skel--input" aria-label="Loading channels" />}
          {loadError && <span className="field__error">Couldn’t load channels: {loadError} <button type="button" className="link-btn" onClick={loadChannels}>Retry</button></span>}
          {channels && channels.length === 0 && <span className="field__hint">No channels yet. Add one in the Factory dashboard first.</span>}
          {channels && channels.length > 0 && (
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">Choose a channel</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}{c.niche ? `, ${c.niche}` : ""}</option>)}
            </select>
          )}
        </label>

        {mode === "viral_breakdown" && (
          <label className="field">
            <span className="field__label">Hit video link</span>
            <input className="input input--mono" inputMode="url" value={video} onChange={(e) => setVideo(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" />
            <span className="field__hint">The agent studies its hook, structure and title pattern. It never copies the script or footage.</span>
          </label>
        )}

        <label className="field">
          <span className="field__label">{mode === "topic" ? "Topic" : "Working title (optional)"}</span>
          <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={mode === "topic" ? "Why octopuses have three hearts" : "Leave empty to use the video link"} />
        </label>

        <label className="field">
          <span className="field__label">Notes for research (optional)</span>
          <textarea className="input input--area" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Format, length, an angle to try, sources to avoid…" />
        </label>

        <fieldset className="field">
          <legend className="field__label">Who researches</legend>
          <div className="segmented">
            <label className="segmented__opt"><input type="radio" name="who" checked={who === "agent"} onChange={() => setWho("agent")} /><span>Research agent</span></label>
            <label className="segmented__opt"><input type="radio" name="who" checked={who === "human"} onChange={() => setWho("human")} /><span>Me</span></label>
          </div>
        </fieldset>

        {who === "agent" && (
          <label className="check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>Hand off to Script by itself when the brief has an angle, 5 sourced facts (3 checked at the source) and 3 competitors. Otherwise it waits for review.</span>
          </label>
        )}

        {error && <p className="field__error" role="alert">{error}</p>}
        <div className="form__actions">
          <button className="btn btn--primary" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Creating…" : who === "agent" ? "Queue for the agent" : "Create and claim"}</button>
        </div>
      </form>
    </section>
  );
}
