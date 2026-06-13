import { useQuery } from '@tanstack/react-query';
import { fetchAlerts } from '../api.js';
import { formatInstant } from '../format.js';

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
      <p className="microlabel">Alert deliveries</p>
      <div className="panel">
        {data.map((a) => (
          <div key={a.id} className="row alert">
            <span>
              <span className={`badge ${a.status === 'sent' ? 'monitoring' : 'BREAKING'}`}>
                {a.status}
              </span>{' '}
              {a.channel}
              {a.error && <span className="url"> — {a.error}</span>}
            </span>
            <span className="when">{formatInstant(a.createdAt)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
