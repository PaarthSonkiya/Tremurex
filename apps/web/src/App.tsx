import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DependencyList } from './views/DependencyList.js';
import { TimelineView } from './views/TimelineView.js';
import { DiffView } from './views/DiffView.js';
import { BrandMark, TraceLine } from './views/Seismograph.js';

type View =
  | { view: 'list' }
  | { view: 'timeline'; depId: string }
  | { view: 'diff'; depId: string; diffId: string };

const queryClient = new QueryClient();

function Masthead() {
  return (
    <header className="masthead">
      <div className="brand">
        <BrandMark />
        <div className="wordmark">
          <b>Tremurex</b>
          <span className="sub">drift monitor</span>
        </div>
      </div>
      <TraceLine />
      <span
        className="local-badge"
        title="Tremurex runs entirely in your environment. No captured data, schema, or telemetry ever leaves this machine."
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M3 5V3.6a3 3 0 0 1 6 0V5"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
          <rect x="2.2" y="5" width="7.6" height="5" rx="1.3" fill="currentColor" />
        </svg>
        Local-only
      </span>
    </header>
  );
}

function Colophon() {
  return (
    <footer className="colophon">
      <span>
        <b>Tremurex</b> — structural drift detection that runs on your own infrastructure. Nothing
        is ever sent anywhere.
      </span>
    </footer>
  );
}

export function App() {
  const [view, setView] = useState<View>({ view: 'list' });

  return (
    <QueryClientProvider client={queryClient}>
      <div className="app">
        <Masthead />
        <main className="stage" key={view.view + ('depId' in view ? view.depId : '')}>
          {view.view === 'list' && (
            <DependencyList
              onSelect={(depId) => {
                setView({ view: 'timeline', depId });
              }}
            />
          )}
          {view.view === 'timeline' && (
            <TimelineView
              depId={view.depId}
              onBack={() => {
                setView({ view: 'list' });
              }}
              onSelectDiff={(diffId) => {
                setView({ view: 'diff', depId: view.depId, diffId });
              }}
            />
          )}
          {view.view === 'diff' && (
            <DiffView
              diffId={view.diffId}
              onBack={() => {
                setView({ view: 'timeline', depId: view.depId });
              }}
            />
          )}
        </main>
        <Colophon />
      </div>
    </QueryClientProvider>
  );
}
