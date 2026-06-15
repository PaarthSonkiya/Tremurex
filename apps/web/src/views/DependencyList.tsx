import { useQuery } from '@tanstack/react-query';
import { fetchDependencies } from '../api.js';
import type { Dependency } from '../api.js';
import { Chevron, Chip, Dot, EmptyState, ErrorNote, Loading } from '../ui.js';
import type { Tone } from '../ui.js';
import { RegisterForm } from './RegisterForm.js';

/** One dot summarises a dependency's health: open drift wins, else learning vs steady. */
function healthDot(dep: Dependency): { tone: Tone; live: boolean } {
  if (dep.currentDrift) return { tone: dep.currentDrift.severity, live: false };
  if (dep.status === 'baselining') return { tone: 'muted', live: true };
  return { tone: 'ok', live: false };
}

export function DependencyList({ onSelect }: { onSelect: (depId: string) => void }) {
  const { data, isPending, error } = useQuery({
    queryKey: ['dependencies'],
    queryFn: fetchDependencies,
    refetchInterval: 15_000,
  });

  return (
    <section>
      <div className="section-head">
        <p className="eyebrow">
          Monitored dependencies
          {data && <span className="count">{data.length}</span>}
        </p>
        <RegisterForm />
      </div>

      {isPending && <Loading label="Reading dependencies…" />}
      {error && <ErrorNote message={`Couldn't reach the core service — ${error.message}`} />}
      {data && data.length === 0 && (
        <EmptyState
          title="Nothing under watch yet"
          hint="Register an API or MCP server and Tremurex starts learning its shape."
        />
      )}

      {data && data.length > 0 && (
        <div className="panel">
          {data.map((dep) => {
            const health = healthDot(dep);
            return (
              <button
                key={dep.id}
                type="button"
                className="dep"
                onClick={() => {
                  onSelect(dep.id);
                }}
              >
                <span className="lead">
                  <Dot tone={health.tone} live={health.live} />
                  <span className="identity">
                    <span className="name">
                      {dep.name}
                      {!dep.enabled && <span className="chip muted outline-dashed">paused</span>}
                    </span>
                    <span className="endpoint">
                      <span className="verb">{dep.kind === 'mcp' ? 'MCP' : dep.method}</span>{' '}
                      {dep.url}
                    </span>
                  </span>
                </span>
                <span className="meta">
                  {dep.currentDrift && (
                    <Chip tone={dep.currentDrift.severity}>{dep.currentDrift.severity}</Chip>
                  )}
                  {dep.kind === 'mcp' && <Chip>mcp</Chip>}
                  {dep.captureMode === 'proxy' ? (
                    <Chip>proxy</Chip>
                  ) : (
                    <span className="cadence">{dep.pollIntervalSeconds}s</span>
                  )}
                  <Chevron />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
