import { FormEvent, useCallback, useEffect, useState } from "react";
import { AdminUser, ago, api, Me, Token } from "../lib/api";

const PIPELINE_ROLES = ["research", "content", "production", "publish"];

export function Tokens({ me }: { me: Me }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [roles, setRoles] = useState<{ code: string; label: string }[]>([]);
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [u, t] = await Promise.all([api.users(), api.tokens()]);
      setUsers(u.users); setRoles(u.roles); setTokens(t); setError("");
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <section className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Access tokens</h1>
          <p className="page__lede">One token belongs to one person and one role. A person with two roles gets two tokens. Only a fingerprint of each token is stored.</p>
        </div>
      </div>
      {error && <div className="notice notice--error" role="alert"><p>{error}</p><button type="button" className="btn" onClick={load}>Try again</button></div>}
      <div className="split split--wide">
        <MintForm me={me} users={users} roles={roles} onMinted={load} />
        <NewUser onCreated={load} />
      </div>
      {me.role === "owner" && <AgentWebhook />}
      <section className="sheet">
        <h2 className="sheet__head">Tokens</h2>
        {tokens === null && !error && [0, 1, 2].map((i) => <span key={i} className="skel skel--line" style={{ width: `${80 - i * 12}%`, margin: "0.9rem 0" }} />)}
        {tokens && tokens.length === 0 && <p className="muted">No tokens yet. Mint the first one above.</p>}
        {tokens && tokens.length > 0 && (
          <table className="table table--rows">
            <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col" className="hide-s">Label</th><th scope="col" className="hide-s">Token starts</th><th scope="col" className="num">Last used</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className={t.revoked_at ? "is-revoked" : undefined}>
                  <td>{t.display_name}<span className="row-sub">{t.username}</span></td>
                  <td>{t.role}</td>
                  <td className="hide-s">{t.label}</td>
                  <td className="hide-s mono-s">{t.token_prefix}…</td>
                  <td className="num">{t.revoked_at ? "Revoked" : t.last_used_at ? ago(t.last_used_at) : "Never"}</td>
                  <td className="cell-action">{!t.revoked_at && <RevokeButton token={t} onDone={load} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="sheet">
        <h2 className="sheet__head">People and roles</h2>
        {users && (
          <table className="table">
            <thead><tr><th scope="col">Person</th><th scope="col">Kind</th><th scope="col">Roles</th></tr></thead>
            <tbody>{users.map((u) => <tr key={u.id}><td>{u.display_name}<span className="row-sub">{u.username}</span></td><td>{u.kind === "agent" ? "Agent" : "Person"}</td><td>{u.roles.join(", ") || <span className="muted">none</span>}</td></tr>)}</tbody>
          </table>
        )}
        <p className="fine">Minting a token for a role also gives the person that role. The pipeline roles are {PIPELINE_ROLES.join(", ")}; writer, assets, editor and uploader are the older CM roles.</p>
      </section>
    </section>
  );
}

function RevokeButton({ token, onDone }: { token: Token; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="link-btn link-btn--danger" disabled={busy} aria-busy={busy} onClick={async () => {
      if (!window.confirm(`Revoke ${token.display_name}'s ${token.role} token? Anyone using it is signed out at once.`)) return;
      setBusy(true);
      try { await api.revokeToken(token.id); onDone(); } catch (e: any) { window.alert(e.message); setBusy(false); }
    }}>{busy ? "Revoking…" : "Revoke"}</button>
  );
}

function MintForm({ me, users, roles, onMinted }: { me: Me; users: AdminUser[] | null; roles: { code: string; label: string }[]; onMinted: () => void }) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("research");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [minted, setMinted] = useState<{ token: string; who: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!userId) return setError("Pick a person.");
    setBusy(true); setError(""); setMinted(null); setCopied(false);
    try {
      const r = await api.mintToken({ user_id: userId, role, label: label.trim(), expires_days: days ? Number(days) : undefined });
      setMinted({ token: r.token, who: `${users?.find((u) => u.id === userId)?.display_name} as ${role}` });
      setLabel(""); onMinted();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  const choosable = roles.filter((r) => r.code !== "owner" || me.role === "owner");

  return (
    <form className="sheet form" onSubmit={submit} noValidate>
      <h2 className="sheet__head">Mint a token</h2>
      <label className="field"><span className="field__label">Person</span>
        {users ? (
          <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose a person</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.username})</option>)}
          </select>
        ) : <span className="skel skel--input" />}
      </label>
      <label className="field"><span className="field__label">Role</span>
        <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
          {choosable.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </label>
      <label className="field"><span className="field__label">Label (optional)</span><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Phone, laptop, freelancer name…" /></label>
      <label className="field"><span className="field__label">Expires after, days (optional)</span><input className="input input--mono input--s" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} placeholder="never" /></label>
      {error && <p className="field__error" role="alert">{error}</p>}
      <button className="btn btn--primary" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Minting…" : "Mint token"}</button>
      {minted && (
        <div className="minted" role="status">
          <p>Token for {minted.who}. Copy it now: it is shown only once.</p>
          <code className="minted__token">{minted.token}</code>
          <button type="button" className="btn" onClick={() => { navigator.clipboard?.writeText(minted.token).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy token"}</button>
        </div>
      )}
    </form>
  );
}

function NewUser({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try { await api.createUser({ username: username.trim(), display_name: name.trim() }); setMsg({ ok: true, text: `Added ${name || username}. Now mint a token for them.` }); setUsername(""); setName(""); onCreated(); }
    catch (err: any) { setMsg({ ok: false, text: err.message }); } finally { setBusy(false); }
  }
  return (
    <form className="sheet form" onSubmit={submit} noValidate>
      <h2 className="sheet__head">Add a person</h2>
      <label className="field"><span className="field__label">Username</span><input className="input input--mono" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="ama.k" autoCapitalize="off" /></label>
      <label className="field"><span className="field__label">Display name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ama K." /></label>
      {msg && <p className={msg.ok ? "field__ok" : "field__error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      <button className="btn" type="submit" disabled={busy || !username} aria-busy={busy}>{busy ? "Adding…" : "Add person"}</button>
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
      <p className="page__lede">New jobs wake the agent through the OpenBot routine “YT Factory: research pipeline”. Make its signing secret in OpenBot, routine settings, and paste it here once. It is stored on the server, never shown again.</p>
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
