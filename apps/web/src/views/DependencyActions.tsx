import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  deleteDependency,
  pollDependency,
  rebaselineDependency,
  updateDependency,
} from '../api.js';
import type { DependencyConfig } from '../api.js';

export function DependencyActions({
  dependency,
  onEdit,
  onDeleted,
}: {
  dependency: DependencyConfig;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['timeline', dependency.id] });
  const refreshAll = async () => {
    await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['dependencies'] })]);
  };

  const poll = useMutation({
    mutationFn: () => pollDependency(dependency.id),
    onSuccess: refreshAll,
  });
  const rebaseline = useMutation({
    mutationFn: () => rebaselineDependency(dependency.id),
    onSuccess: refreshAll,
  });
  const toggle = useMutation({
    mutationFn: () => updateDependency(dependency.id, { enabled: !dependency.enabled }),
    onSuccess: refreshAll,
  });
  const remove = useMutation({
    mutationFn: () => deleteDependency(dependency.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['dependencies'] });
      onDeleted();
    },
  });

  const busy = poll.isPending || rebaseline.isPending || toggle.isPending || remove.isPending;
  const error = poll.error ?? rebaseline.error ?? toggle.error ?? remove.error;

  return (
    <div className="actions">
      {dependency.captureMode === 'poll' && (
        <button
          type="button"
          className="ghost"
          disabled={busy || !dependency.enabled}
          onClick={() => {
            poll.mutate();
          }}
        >
          {poll.isPending ? 'Polling…' : 'Poll now'}
        </button>
      )}
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() => {
          if (
            confirm(
              'Re-baseline? The current baseline is discarded and relearned from new captures.',
            )
          ) {
            rebaseline.mutate();
          }
        }}
      >
        Re-baseline
      </button>
      <button type="button" className="ghost" disabled={busy} onClick={onEdit}>
        Edit
      </button>
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() => {
          toggle.mutate();
        }}
      >
        {dependency.enabled ? 'Pause' : 'Resume'}
      </button>
      <button
        type="button"
        className="ghost danger"
        disabled={busy}
        onClick={() => {
          if (confirm(`Delete "${dependency.name}" and all its history? This cannot be undone.`)) {
            remove.mutate();
          }
        }}
      >
        Delete
      </button>
      {error && <span className="status-note error inline">{error.message}</span>}
    </div>
  );
}
