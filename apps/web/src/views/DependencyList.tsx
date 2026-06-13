import { useQuery } from '@tanstack/react-query';
import { fetchDependencies } from '../api.js';

export function DependencyList({ onSelect }: { onSelect: (depId: string) => void }) {
  const { data, isPending, error } = useQuery({
    queryKey: ['dependencies'],
    queryFn: fetchDependencies,
    refetchInterval: 15_000,
  });

  if (isPending) return <p className="status-note">Loading dependencies…</p>;
  if (error) return <p className="status-note error">Failed to load: {error.message}</p>;
  if (data.length === 0) {
    return (
      <p className="status-note">
        No dependencies monitored yet. Register one with <code>POST /dependencies</code>.
      </p>
    );
  }

  return (
    <section>
      <p className="microlabel">Monitored dependencies</p>
      <div className="panel">
        {data.map((dep) => (
          <button
            key={dep.id}
            type="button"
            className="row"
            onClick={() => {
              onSelect(dep.id);
            }}
          >
            <span>
              <span className="name">{dep.name}</span>
              <br />
              <span className="url">
                {dep.kind === 'mcp' ? 'MCP' : dep.method} {dep.url}
              </span>
            </span>
            <span className="meta">
              {dep.kind === 'mcp' && <span className="badge kind">mcp</span>}
              {dep.captureMode === 'proxy' ? (
                <span className="badge kind">proxy</span>
              ) : (
                <span>every {dep.pollIntervalSeconds}s</span>
              )}
              <span className={`badge ${dep.status}`}>{dep.status}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
