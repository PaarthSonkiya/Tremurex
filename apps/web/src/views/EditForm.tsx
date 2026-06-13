import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateDependency } from '../api.js';
import type { DependencyConfig, Severity, UpdateInput } from '../api.js';

export function EditForm({
  dependency,
  onClose,
}: {
  dependency: DependencyConfig;
  onClose: () => void;
}) {
  const [name, setName] = useState(dependency.name);
  const [url, setUrl] = useState(dependency.url);
  const [interval, setInterval] = useState(dependency.pollIntervalSeconds);
  const [threshold, setThreshold] = useState<Severity>(dependency.alertThreshold);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => {
      const patch: UpdateInput = {};
      if (name.trim() !== dependency.name) patch.name = name.trim();
      if (url.trim() !== dependency.url) patch.url = url.trim();
      if (interval !== dependency.pollIntervalSeconds) patch.pollIntervalSeconds = interval;
      if (threshold !== dependency.alertThreshold) patch.alertThreshold = threshold;
      return updateDependency(dependency.id, patch);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timeline', dependency.id] }),
        queryClient.invalidateQueries({ queryKey: ['dependencies'] }),
      ]);
      onClose();
    },
  });

  return (
    <form
      className="panel form"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <label>
        <span className="microlabel">Name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </label>
      <label>
        <span className="microlabel">URL</span>
        <input
          value={url}
          type="url"
          onChange={(e) => {
            setUrl(e.target.value);
          }}
        />
      </label>
      <div className="form-row">
        {dependency.captureMode === 'poll' && (
          <label>
            <span className="microlabel">Poll every (s)</span>
            <input
              type="number"
              min={5}
              max={86400}
              value={interval}
              onChange={(e) => {
                setInterval(Number(e.target.value));
              }}
            />
          </label>
        )}
        <label>
          <span className="microlabel">Alert at</span>
          <select
            value={threshold}
            onChange={(e) => {
              setThreshold(e.target.value as Severity);
            }}
          >
            <option value="BREAKING">BREAKING</option>
            <option value="WARNING">WARNING</option>
            <option value="INFO">INFO</option>
          </select>
        </label>
      </div>
      {mutation.error && <p className="status-note error">{mutation.error.message}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
