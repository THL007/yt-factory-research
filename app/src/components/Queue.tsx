import { useCallback, useEffect, useState } from "react";
import { ago, api, canResearch, Job, JobStatus, Me, STATUS_LABEL } from "../lib/api";

const FILTERS: { id: string; label: string; statuses?: JobStatus[] }[] = [
  { id: "open", label: "Open", statuses: ["queued", "running", "review", "failed"] },
  { id: "review", label: "Needs review", statuses: ["review"] },
  { id: "handed_off", label: "In Script", statuses: ["handed_off"] },
  { id: "all", label: "All" },
];

function readFilter() {
  if (typeof window === "undefined") return "open";
  const f = new URLSearchParams(window.location.search).get("filter");
  return FILTERS.some((x) => x.id === f) ? (f as string) : "open";
}

export function Queue({ me, onOpen, onNew }: { me: Me; onOpen: (id: string) => void; onNew: () => void }) {
  const [filter, setFilterState] = useState(readFilter);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const f = FILTERS.find((x) => x.id === filter)!;
      setJobs(await api.jobs(f.statuses?.join(",")));
      setError("");
    } catch (e: any) { setError(e.message); }
  }, [filter]);

  useEffect(() => { setJobs(null); load(); }, [load]);
  // While the agent works, keep the table current.
  useEffect(() => {
    if (!jobs?.some((j) => j.status === "queued" || j.status === "running")) return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const setFilter = (id: string) => {
    const url = new URL(window.location.href);
    if (id === "open") url.searchParams.delete("filter"); else url.searchParams.set("filter", id);
    window.history.replaceState({}, "", url);
    setFilterState(id);
  };

  return (
    <section className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Research queue</h1>
          <p className="page__lede">Each row is a video in the Idea stage. A finished brief moves the video to Script.</p>
        </div>
        {canResearch(me.role) && <button type="button" className="btn btn--primary" onClick={onNew}>New research job</button>}
      </div>

      <div className="filters" role="group" aria-label="Filter jobs">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>

      <div className="sheet">
        {error && (
          <div className="notice notice--error" role="alert">
            <p>Couldn’t load the queue: {error}</p>
            <button type="button" className="btn" onClick={load}>Try again</button>
          </div>
        )}
        {!error && jobs === null && <TableSkeleton />}
        {!error && jobs && jobs.length === 0 && (
          <div className="empty">
            <p className="empty__title">{filter === "open" ? "Nothing waiting for research." : "No jobs here yet."}</p>
            <p>A job starts from a topic or a hit video. The research agent writes the brief, or you claim it and write it yourself.</p>
            {canResearch(me.role) && <button type="button" className="btn btn--primary" onClick={onNew}>New research job</button>}
          </div>
        )}
        {!error && jobs && jobs.length > 0 && (
          <table className="table table--rows">
            <thead>
              <tr>
                <th scope="col">Video</th>
                <th scope="col" className="hide-s">Channel</th>
                <th scope="col">Status</th>
                <th scope="col" className="hide-s">Who</th>
                <th scope="col" className="num">Updated</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="row-link" onClick={() => onOpen(j.id)}>
                  <td>
                    <a href={`?view=job&job=${j.id}`} className="row-title" onClick={(e) => { e.preventDefault(); onOpen(j.id); }}>{j.title_working}</a>
                    <span className="row-sub">{j.mode === "viral_breakdown" ? "Viral breakdown" : "Topic"}{j.angle ? `. ${j.angle}` : ""}</span>
                  </td>
                  <td className="hide-s">{j.channel_name}</td>
                  <td><span className={`status status--${j.status}`}>{STATUS_LABEL[j.status]}</span>{j.status === "failed" && j.error && <span className="row-sub">{j.error.slice(0, 80)}</span>}</td>
                  <td className="hide-s">{j.assignee_kind === "agent" ? "Agent" : j.assigned_name || "Unclaimed"}</td>
                  <td className="num">{ago(j.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function TableSkeleton() {
  return (
    <div className="skel-table" aria-busy="true" aria-label="Loading jobs">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="skel-row"><span className="skel skel--line" style={{ width: "46%" }} /><span className="skel skel--line" style={{ width: "14%" }} /><span className="skel skel--line" style={{ width: "10%" }} /></div>
      ))}
    </div>
  );
}

Queue.Skeleton = function QueueSkeleton() {
  return (
    <section className="page">
      <div className="page__head"><span className="skel skel--head" /></div>
      <div className="sheet"><TableSkeleton /></div>
    </section>
  );
};
