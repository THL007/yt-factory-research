import { useCallback, useEffect, useState } from "react";
import { api, getSettings, isAdmin, Me, signOut } from "../lib/api";
import { SignIn } from "../components/SignIn";
import { Queue } from "../components/Queue";
import { NewJob } from "../components/NewJob";
import { BriefView } from "../components/BriefView";
import { Tokens } from "../components/Tokens";

type View = "queue" | "new" | "job" | "tokens";

function readUrl(): { view: View; job: string | null } {
  if (typeof window === "undefined") return { view: "queue", job: null };
  const q = new URLSearchParams(window.location.search);
  const v = q.get("view");
  const job = q.get("job");
  return { view: v === "new" || v === "tokens" || (v === "job" && job) ? (v as View) : "queue", job };
}

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [boot, setBoot] = useState<"loading" | "signed-out" | "ready" | "error">("loading");
  const [bootError, setBootError] = useState("");
  const [{ view, job }, setRoute] = useState<{ view: View; job: string | null }>({ view: "queue", job: null });

  const load = useCallback(async () => {
    if (!getSettings().token) { setBoot("signed-out"); return; }
    setBoot("loading");
    try { setMe(await api.me()); setBoot("ready"); }
    catch (e: any) {
      if (e.status === 401) { signOut(); setBoot("signed-out"); }
      else { setBootError(e.message); setBoot("error"); }
    }
  }, []);

  useEffect(() => {
    setRoute(readUrl());
    load();
    const onPop = () => setRoute(readUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [load]);

  const go = (v: View, jobId?: string) => {
    const url = new URL(window.location.href);
    url.search = "";
    if (v !== "queue") url.searchParams.set("view", v);
    if (jobId) url.searchParams.set("job", jobId);
    window.history.pushState({}, "", url);
    setRoute({ view: v, job: jobId || null });
    window.scrollTo({ top: 0 });
  };

  if (boot === "signed-out") return <SignIn onDone={load} />;

  const tabs: { id: View; label: string }[] = [
    { id: "queue", label: "Queue" },
    { id: "new", label: "New job" },
    ...(me && isAdmin(me.role) ? [{ id: "tokens" as View, label: "Tokens" }] : []),
  ];

  return (
    <div className="app">
      <header className="bar">
        <div className="bar__in">
          <a className="wordmark" href="./" onClick={(e) => { e.preventDefault(); go("queue"); }}>
            <span className="wordmark__name">Research desk</span>
            <span className="wordmark__sub">YT factory, Idea stage</span>
          </a>
          <nav className="tabs" aria-label="Sections">
            {tabs.map((t) => (
              <button key={t.id} type="button" className="tab" aria-current={view === t.id || (t.id === "queue" && view === "job") ? "page" : undefined} onClick={() => go(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="who">
            {me ? <><span className="who__name">{me.user.display_name}</span><span className="who__role">{me.role}</span></> : <span className="skel skel--line" style={{ width: 96 }} />}
            <button type="button" className="link-btn" onClick={() => { signOut(); setMe(null); setBoot("signed-out"); }}>Sign out</button>
          </div>
        </div>
      </header>

      <main className="main">
        {boot === "error" && (
          <div className="notice notice--error" role="alert">
            <p>{bootError}</p>
            <button type="button" className="btn" onClick={load}>Try again</button>
          </div>
        )}
        {boot === "loading" && <Queue.Skeleton />}
        {boot === "ready" && me && (
          <>
            {view === "queue" && <Queue me={me} onOpen={(id) => go("job", id)} onNew={() => go("new")} />}
            {view === "new" && <NewJob me={me} onCreated={(id) => go("job", id)} />}
            {view === "job" && job && <BriefView key={job} id={job} me={me} onBack={() => go("queue")} />}
            {view === "tokens" && isAdmin(me.role) && <Tokens me={me} />}
          </>
        )}
      </main>
    </div>
  );
}
