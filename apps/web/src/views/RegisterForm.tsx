import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { registerDependency } from '../api.js';
import type { RegisterInput, Severity } from '../api.js';

const EMPTY: RegisterInput = {
  name: '',
  kind: 'rest',
  captureMode: 'poll',
  url: '',
  method: 'GET',
  pollIntervalSeconds: 300,
  alertThreshold: 'WARNING',
};

export function RegisterForm() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<RegisterInput>(EMPTY);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => {
      // MCP catalogs and proxy capture don't use the poll method/cadence.
      const payload: RegisterInput = { ...form, name: form.name.trim(), url: form.url.trim() };
      return registerDependency(payload);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['dependencies'] });
      setForm(EMPTY);
      setOpen(false);
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        className="primary"
        onClick={() => {
          setOpen(true);
        }}
      >
        + Monitor a dependency
      </button>
    );
  }

  const isMcp = form.kind === 'mcp';
  const isProxy = form.captureMode === 'proxy';

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
          value={form.name}
          required
          placeholder="github-repo-api"
          onChange={(e) => {
            setForm({ ...form, name: e.target.value });
          }}
        />
      </label>

      <div className="form-row">
        <label>
          <span className="microlabel">Kind</span>
          <select
            value={form.kind}
            onChange={(e) => {
              const kind = e.target.value as RegisterInput['kind'];
              // MCP can't be proxy-captured; force poll.
              setForm({ ...form, kind, captureMode: kind === 'mcp' ? 'poll' : form.captureMode });
            }}
          >
            <option value="rest">REST</option>
            <option value="mcp">MCP</option>
          </select>
        </label>
        <label>
          <span className="microlabel">Capture</span>
          <select
            value={form.captureMode}
            disabled={isMcp}
            onChange={(e) => {
              setForm({ ...form, captureMode: e.target.value as RegisterInput['captureMode'] });
            }}
          >
            <option value="poll">Poll</option>
            <option value="proxy">Proxy</option>
          </select>
        </label>
        {form.kind === 'rest' && form.captureMode === 'poll' && (
          <label>
            <span className="microlabel">Method</span>
            <select
              value={form.method}
              onChange={(e) => {
                setForm({ ...form, method: e.target.value as 'GET' | 'POST' });
              }}
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
          </label>
        )}
      </div>

      <label>
        <span className="microlabel">{isProxy ? 'URL prefix to match' : 'URL'}</span>
        <input
          value={form.url}
          required
          type="url"
          placeholder={isMcp ? 'https://mcp.example.com/mcp' : 'https://api.example.com/v1/things'}
          onChange={(e) => {
            setForm({ ...form, url: e.target.value });
          }}
        />
      </label>

      <div className="form-row">
        {!isProxy && (
          <label>
            <span className="microlabel">Poll every (s)</span>
            <input
              type="number"
              min={5}
              max={86400}
              value={form.pollIntervalSeconds}
              onChange={(e) => {
                setForm({ ...form, pollIntervalSeconds: Number(e.target.value) });
              }}
            />
          </label>
        )}
        <label>
          <span className="microlabel">Alert at</span>
          <select
            value={form.alertThreshold}
            onChange={(e) => {
              setForm({ ...form, alertThreshold: e.target.value as Severity });
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
          {mutation.isPending ? 'Registering…' : 'Register'}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setOpen(false);
            mutation.reset();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
