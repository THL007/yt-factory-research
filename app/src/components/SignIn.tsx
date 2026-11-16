import { FormEvent, useState } from "react";
import { api, DEFAULT_API, saveSettings } from "../lib/api";

export function SignIn({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [apiUrl, setApiUrl] = useState(DEFAULT_API);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const s = { api: apiUrl.trim(), token: token.trim() };
    if (!/^ytf_[a-f0-9]{48}$/.test(s.token)) { setError("A factory token starts with ytf_ followed by 48 characters."); return; }
    setBusy(true); setError("");
    try { await api.me(s); saveSettings(s); onDone(); }
    catch (err: any) { setError(err.status === 401 ? "That token is not valid, revoked or expired. Ask the owner for a new one." : err.message); }
    finally { setBusy(false); }
  }

  return (
    <main className="signin">
      <form className="sheet signin__sheet" onSubmit={submit} noValidate>
        <h1 className="signin__title">Research desk</h1>
        <p className="signin__lede">Paste the access token the owner gave you. It decides your role: research, content, production, publish, admin or owner.</p>
        <label className="field">
          <span className="field__label">Access token</span>
          <input className="input input--mono" type="password" autoComplete="off" spellCheck={false} value={token}
            onChange={(e) => setToken(e.target.value)} placeholder="ytf_…" aria-invalid={!!error} aria-describedby={error ? "signin-err" : undefined} />
        </label>
        <details className="disclosure">
          <summary>API address</summary>
          <label className="field">
            <span className="field__label">Factory API</span>
            <input className="input input--mono" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
          </label>
        </details>
        {error && <p id="signin-err" className="field__error" role="alert">{error}</p>}
        <button className="btn btn--primary" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Checking…" : "Sign in"}</button>
        <p className="fine">The token stays in this browser. Signing out removes it.</p>
      </form>
    </main>
  );
}
