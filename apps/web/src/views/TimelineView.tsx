import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchTimeline } from '../api.js';
import { formatInstant } from '../format.js';
import { Chip, Dot, EmptyState, ErrorNote, Loading } from '../ui.js';
import { AlertHistory } from './AlertHistory.js';
import { DependencyActions } from './DependencyActions.js';
import { EditForm } from './EditForm.js';

export function TimelineView({
  depId,
  onBack,
  onSelectDiff,
}: {
  depId: string;
  onBack: () => void;
  onSelectDiff: (diffId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const { data, isPending, error } = useQuery({
    queryKey: ['timeline', depId],
    queryFn: () => fetchTimeline(depId),
    refetchInterval: 15_000,
  });

  return (
    <section>
      <button type="button" className="backlink" onClick={onBack}>
        <span className="arrow">←</span> All dependencies
      </button>
      {isPending && <Loading label="Reading timeline…" />}
      {error && <ErrorNote message={`Couldn't load this timeline — ${error.message}`} />}
      {data && (
        <>
          <div className="timeline-head">
            <h2>{data.dependency.name}</h2>
            <p className="endpoint">
              <span className="verb">
                {data.dependency.kind === 'mcp' ? 'MCP' : data.dependency.method}
              </span>{' '}
              {data.dependency.url}
            </p>
            <p className="statusline">
              <Dot
                tone={data.status === 'baselining' ? 'muted' : 'ok'}
                live={data.status === 'baselining'}
              />
              <Chip tone={data.status === 'baselining' ? 'muted' : 'ok'}>{data.status}</Chip>
              {!data.dependency.enabled && (
                <span className="chip muted outline-dashed">paused</span>
              )}
              {data.status === 'baselining' && (
                <span>
                  {data.samplesCollected} of {data.dependency.baselineWindow} samples collected
                </span>
              )}
            </p>
            <DependencyActions
              dependency={data.dependency}
              onEdit={() => {
                setEditing((v) => !v);
              }}
              onDeleted={onBack}
            />
          </div>

          {editing && (
            <EditForm
              dependency={data.dependency}
              onClose={() => {
                setEditing(false);
              }}
            />
          )}

          {data.events.length === 0 ? (
            <EmptyState
              title="No drift recorded"
              hint="Tremurex is still collecting baseline samples. Events appear here once it locks a baseline."
            />
          ) : (
            <div className="trace">
              {data.events.map((event) =>
                event.type === 'drift' ? (
                  <article key={event.id} className={`tick ${event.severity}`}>
                    <span className="node" />
                    <button
                      type="button"
                      className="tick-card"
                      onClick={() => {
                        onSelectDiff(event.id);
                      }}
                    >
                      <span className="summary">
                        <Chip tone={event.severity}>{event.severity}</Chip>
                        <span className="changes">
                          {event.entryCount} change{event.entryCount === 1 ? '' : 's'}
                        </span>
                        {event.resolvedAt === null ? (
                          <Chip tone={event.severity}>open</Chip>
                        ) : (
                          <span className="chip muted outline-dashed">resolved</span>
                        )}
                      </span>
                      <span className="when">
                        {formatInstant(event.at)}
                        {event.lastSeenAt !== event.at && (
                          <>
                            {' '}
                            <span className="faint">
                              · last seen {formatInstant(event.lastSeenAt)}
                            </span>
                          </>
                        )}
                      </span>
                    </button>
                  </article>
                ) : (
                  <article key={event.id} className="tick locked">
                    <span className="node" />
                    <div className="tick-card static">
                      <span className="summary">
                        <span className="changes">Baseline locked</span>
                        <span className="chip muted">{event.sampleCount} samples</span>
                      </span>
                      <span className="when">{formatInstant(event.at)}</span>
                    </div>
                  </article>
                ),
              )}
            </div>
          )}

          <AlertHistory depId={depId} />
        </>
      )}
    </section>
  );
}
