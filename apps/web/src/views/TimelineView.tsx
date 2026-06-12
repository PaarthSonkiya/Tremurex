import { useQuery } from '@tanstack/react-query';
import { fetchTimeline } from '../api.js';
import { formatInstant } from '../format.js';

export function TimelineView({
  depId,
  onBack,
  onSelectDiff,
}: {
  depId: string;
  onBack: () => void;
  onSelectDiff: (diffId: string) => void;
}) {
  const { data, isPending, error } = useQuery({
    queryKey: ['timeline', depId],
    queryFn: () => fetchTimeline(depId),
    refetchInterval: 15_000,
  });

  return (
    <section>
      <button type="button" className="backlink" onClick={onBack}>
        ← all dependencies
      </button>
      {isPending && <p className="status-note">Loading timeline…</p>}
      {error && <p className="status-note error">Failed to load: {error.message}</p>}
      {data && (
        <>
          <div className="timeline-head">
            <h2>{data.dependency.name}</h2>
            <p className="url">
              {data.dependency.kind === 'mcp' ? 'MCP' : data.dependency.method}{' '}
              {data.dependency.url}
            </p>
            <p className="microlabel">
              <span className={`badge ${data.status}`}>{data.status}</span>{' '}
              {data.status === 'baselining' &&
                `${String(data.samplesCollected)}/${String(data.dependency.baselineWindow)} samples collected`}
            </p>
          </div>
          {data.events.length === 0 ? (
            <p className="status-note">No events yet — still collecting baseline samples.</p>
          ) : (
            <div className="panel">
              {data.events.map((event) =>
                event.type === 'drift' ? (
                  <button
                    key={event.id}
                    type="button"
                    className={`row event ${event.severity}`}
                    onClick={() => {
                      onSelectDiff(event.id);
                    }}
                  >
                    <span>
                      <span className={`badge ${event.severity}`}>{event.severity}</span> drift ·{' '}
                      {event.entryCount} change{event.entryCount === 1 ? '' : 's'}{' '}
                      {event.resolvedAt === null ? (
                        <span className="badge active">active</span>
                      ) : (
                        <span className="badge resolved">resolved</span>
                      )}
                    </span>
                    <span className="when">
                      {formatInstant(event.at)}
                      {event.lastSeenAt !== event.at && (
                        <> · last seen {formatInstant(event.lastSeenAt)}</>
                      )}
                    </span>
                  </button>
                ) : (
                  <div key={event.id} className="row event locked">
                    <span>baseline locked · {event.sampleCount} samples</span>
                    <span className="when">{formatInstant(event.at)}</span>
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
