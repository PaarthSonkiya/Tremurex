/* Small presentational primitives shared across views. Kept deliberately thin:
 * they exist so severity tone, status dots, and empty/loading states look and
 * read identically everywhere. */

import type { ReactNode } from 'react';
import type { Severity } from './api.js';

/** Tone covers the three severities plus the non-severity states we colour. */
export type Tone = Severity | 'ok' | 'muted';

/** A small dot of light. `live` adds the quiet breathing ring (in-progress). */
export function Dot({ tone = 'muted', live = false }: { tone?: Tone; live?: boolean }) {
  return <span className={`dot ${tone}${live ? ' live' : ''}`} />;
}

/** A pill. `tone` colours it; omit for the neutral outline. */
export function Chip({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Loading({ label }: { label: string }) {
  return (
    <p className="status-note">
      <Spinner /> {label}
    </p>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <p className="status-note error">{message}</p>;
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty">
      <svg
        className="emptymark"
        width="40"
        height="22"
        viewBox="0 0 40 22"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M1 11 H13 L17 11 L20 11 L23 11 H39"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
      <h3>{title}</h3>
      <p>{hint}</p>
    </div>
  );
}

/** A right-pointing chevron used as a row affordance. */
export function Chevron() {
  return (
    <svg className="chev" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M5 3 L9 7 L5 11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
