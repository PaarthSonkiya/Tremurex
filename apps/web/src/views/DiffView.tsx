import { useQuery } from '@tanstack/react-query';
import { fetchDiff } from '../api.js';
import { formatInstant } from '../format.js';

function Fragment({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <div className="fragment">
      <p className="microlabel">{label}</p>
      <pre className="code">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export function DiffView({ diffId, onBack }: { diffId: string; onBack: () => void }) {
  const { data, isPending, error } = useQuery({
    queryKey: ['diff', diffId],
    queryFn: () => fetchDiff(diffId),
  });

  return (
    <section>
      <button type="button" className="backlink" onClick={onBack}>
        ← timeline
      </button>
      {isPending && <p className="status-note">Loading diff…</p>}
      {error && <p className="status-note error">Failed to load: {error.message}</p>}
      {data && (
        <>
          <div className="timeline-head">
            <h2>
              <span className={`badge ${data.severity}`}>{data.severity}</span> drift in{' '}
              {data.dependency?.name ?? 'unknown dependency'}
            </h2>
            <p className="microlabel">detected {formatInstant(data.createdAt)}</p>
          </div>
          <div className="panel">
            {data.entries.map((entry, i) => (
              <div key={`${entry.path}-${String(i)}`} className={`diff-entry ${entry.severity}`}>
                <div className="head">
                  <span className={`badge ${entry.severity}`}>{entry.severity}</span>
                  <span className="path">{entry.path}</span>
                  <span className="rule">{entry.rule}</span>
                </div>
                <div className="fragments">
                  <Fragment label="before" value={entry.before} />
                  <Fragment label="after" value={entry.after} />
                </div>
              </div>
            ))}
          </div>
          <details className="schemas">
            <summary>Full schemas (baseline vs captured)</summary>
            <div className="schema-pair">
              <div className="fragment">
                <p className="microlabel">baseline</p>
                <pre className="code">{JSON.stringify(data.baselineSchema, null, 2)}</pre>
              </div>
              <div className="fragment">
                <p className="microlabel">captured</p>
                <pre className="code">{JSON.stringify(data.capturedSchema, null, 2)}</pre>
              </div>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
