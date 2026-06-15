import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchDiff, resolveDiff } from '../api.js';
import { formatInstant } from '../format.js';
import { Chip, ErrorNote, Loading } from '../ui.js';

function Fragment({ side, value }: { side: 'before' | 'after'; value: unknown }) {
  if (value === undefined) return null;
  return (
    <div className={`fragment ${side}`}>
      <p className="microlabel">{side}</p>
      <pre className="code">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export function DiffView({ diffId, onBack }: { diffId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: ['diff', diffId],
    queryFn: () => fetchDiff(diffId),
  });
  const resolve = useMutation({
    mutationFn: () => resolveDiff(diffId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['diff', diffId] }),
        queryClient.invalidateQueries({ queryKey: ['dependencies'] }),
        ...(data?.dependency
          ? [queryClient.invalidateQueries({ queryKey: ['timeline', data.dependency.id] })]
          : []),
      ]);
    },
  });

  return (
    <section>
      <button type="button" className="backlink" onClick={onBack}>
        <span className="arrow">←</span> Timeline
      </button>
      {isPending && <Loading label="Reading diff…" />}
      {error && <ErrorNote message={`Couldn't load this diff — ${error.message}`} />}
      {data && (
        <>
          <div className="diff-head">
            <h2>
              <Chip tone={data.severity}>{data.severity}</Chip> drift
              <span className="in">in {data.dependency?.name ?? 'unknown dependency'}</span>
            </h2>
            <p className="meta-line">
              detected {formatInstant(data.createdAt)}
              {data.lastSeenAt !== data.createdAt && (
                <> · last seen {formatInstant(data.lastSeenAt)}</>
              )}
              {data.resolvedAt === null ? (
                <> · still drifting</>
              ) : (
                <> · resolved {formatInstant(data.resolvedAt)}</>
              )}
            </p>
            {data.resolvedAt === null && (
              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={resolve.isPending}
                  onClick={() => {
                    resolve.mutate();
                  }}
                >
                  {resolve.isPending ? 'Resolving…' : 'Mark resolved'}
                </button>
                {resolve.error && (
                  <span className="status-note error inline">{resolve.error.message}</span>
                )}
              </div>
            )}
          </div>

          <div className="panel">
            {data.entries.map((entry, i) => (
              <div key={`${entry.path}-${String(i)}`} className={`diff-entry ${entry.severity}`}>
                <div className="head">
                  <Chip tone={entry.severity}>{entry.severity}</Chip>
                  <span className="path">{entry.path}</span>
                  <span className="rule">{entry.rule}</span>
                </div>
                <div className="fragments">
                  <Fragment side="before" value={entry.before} />
                  <Fragment side="after" value={entry.after} />
                </div>
              </div>
            ))}
          </div>

          <details className="schemas">
            <summary>Full schemas — baseline vs captured</summary>
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
