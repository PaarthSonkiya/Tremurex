import { useQuery } from '@tanstack/react-query';
import { fetchAlerts } from '../api.js';
import { formatInstant } from '../format.js';
import { Dot } from '../ui.js';

export function AlertHistory({ depId }: { depId: string }) {
  const { data } = useQuery({
    queryKey: ['alerts', depId],
    queryFn: () => fetchAlerts(depId),
    refetchInterval: 15_000,
  });

  // Quiet when loading, errored, or empty — alerts are secondary on this page.
  if (!data || data.length === 0) {
    return null;
  }

  return (
    <section className="alert-history">
      <p className="eyebrow" style={{ marginBottom: '0.75rem' }}>
        Alert deliveries<span className="count">{data.length}</span>
      </p>
      <div className="panel">
        {data.map((a) => (
          <div key={a.id} className="alert-row">
            <span className="lead">
              <Dot tone={a.status === 'sent' ? 'ok' : 'BREAKING'} />
              <span className="channel">{a.channel}</span>
              {a.error && <span className="err">— {a.error}</span>}
            </span>
            <span className="when">{formatInstant(a.createdAt)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
