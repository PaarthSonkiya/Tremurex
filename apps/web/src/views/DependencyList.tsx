import { useQuery } from '@tanstack/react-query';
import { fetchDependencies } from '../api.js';
import { RegisterForm } from './RegisterForm.js';

export function DependencyList({ onSelect }: { onSelect: (depId: string) => void }) {
  const { data, isPending, error } = useQuery({
    queryKey: ['dependencies'],
    queryFn: fetchDependencies,
    refetchInterval: 15_000,
  });

  return (
    <section>
      <div className="section-head">
        <p className="microlabel">Monitored dependencies</p>
        <RegisterForm />
      </div>

      {isPending && <p className="status-note">Loading dependencies…</p>}
      {error && <p className="status-note error">Failed to load: {error.message}</p>}
      {data && data.length === 0 && (
        <p className="status-note">Nothing monitored yet — register a dependency to begin.</p>
      )}

      {data && data.length > 0 && (
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
                {!dep.enabled && <span className="badge paused"> paused</span>}
                <br />
                <span className="url">
                  {dep.kind === 'mcp' ? 'MCP' : dep.method} {dep.url}
                </span>
              </span>
              <span className="meta">
                {dep.currentDrift && (
                  <span className={`badge ${dep.currentDrift.severity}`}>
                    {dep.currentDrift.severity}
                  </span>
                )}
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
      )}
    </section>
  );
}
