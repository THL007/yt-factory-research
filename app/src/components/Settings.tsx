import { FormEvent, useEffect, useState } from "react";
import { api, getSettings, Me, saveSettings } from "../lib/api";

export const DASHBOARD_URL = "https://thl007.github.io/yt-factory-dashboard/";

// The research desk only holds your own token and the agent wake-up secret.
// People, channels and tokens are managed in the Factory dashboard.
export function Settings({ me, onSignedIn }: { me: Me; onSignedIn: () => void }) {
  return (
    <section className="page page--narrow">
      <div className="page__head">
        <div>
          <h1 className="page__title">Settings</h1>
          <p className="page__lede">Signed in as {me.user.display_name}, role {me.role}{me.token_label ? `, token “${me.token_label}”` : ""}. People, channels and tokens are managed in the <a href={DASHBOARD_URL} target="_blank" rel="noopener noreferrer">Factory dashboard</a>.</p>
        </div>
      </div>
      <TokenInput onSignedIn={onSignedIn} />
      {me.role === "owner" ? <AgentWebhook /> : (
        <section className="sheet"><h2 className="sheet__head">Research agent wake-up</h2><p className="muted">Only the owner sets the wake-up secret.</p></section>
      )}
    </section>
  );
}

function TokenInput({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const s = { api: getSettings().api, token: token.trim() };
    if (!/^ytf_[a-f0-9]{48}$/.test(s.token)) { setMsg({ ok: false, text: "A factory token starts with ytf_ followed by 48 characters." }); return; }
    setBusy(true); setMsg(null);
    try { const m = await api.me(s); saveSettings(s); setToken(""); setMsg({ ok: true, text: `Now signed in as ${m.user.display_name} (${m.role}).` }); onSignedIn(); }
    catch (err: any) { setMsg({ ok: false, text: err.status === 401 ? "That token is not valid, revoked or expired." : err.message }); }
    finally { setBusy(false); }
  }
  return (
    <form className="sheet form" onSubmit={submit} noValidate>
      <h2 className="sheet__head">Access token</h2>
      <label className="field"><span className="field__label">Replace your token</span>
        <input className="input input--mono" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="ytf_…" /></label>
      <p className="field__hint">Use this when the owner gives you a new token or a token for another role.</p>
      {msg && <p className={msg.ok ? "field__ok" : "field__error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      <button className="btn" type="submit" disabled={busy || !token.trim()} aria-busy={busy}>{busy ? "Checking…" : "Use this token"}</button>
    </form>
  );
}

function AgentWebhook() {
  const [state, setState] = useState<{ url: string | null; secret_set: boolean } | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.webhook().then(setState).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try { await api.setWebhookSecret(secret.trim()); setSecret(""); setMsg({ ok: true, text: "Saved. New jobs now wake the research agent." }); load(); }
    catch (err: any) { setMsg({ ok: false, text: err.message }); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setMsg(null);
    try { const r = await api.testWebhook(); setMsg({ ok: true, text: r.note }); } catch (err: any) { setMsg({ ok: false, text: err.message }); } finally { setBusy(false); }
  }
  return (
    <form className="sheet form" onSubmit={save} noValidate>
      <div className="sheet__headrow"><h2 className="sheet__head">Research agent wake-up</h2><p className="tally">{state === null ? "Checking…" : state.secret_set ? "Connected" : "Not connected"}</p></div>
      <p className="page__lede">New jobs wake the agent through the OpenBot routine “YT Factory: research pipeline”. Paste its signing secret here; it is stored on the server and never shown again.</p>
      <label className="field"><span className="field__label">Signing secret</span>
        <input className="input input--mono" type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={state?.secret_set ? "Set. Paste a new one to replace it." : "Paste the secret"} /></label>
      {msg && <p className={msg.ok ? "field__ok" : "field__error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      <div className="form__actions">
        <button className="btn btn--primary" type="submit" disabled={busy || secret.trim().length < 16} aria-busy={busy}>Save secret</button>
        {state?.secret_set && <button className="btn" type="button" disabled={busy} onClick={test}>Send a test event</button>}
      </div>
    </form>
  );
}
