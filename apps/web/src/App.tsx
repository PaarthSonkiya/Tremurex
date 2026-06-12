import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DependencyList } from './views/DependencyList.js';
import { TimelineView } from './views/TimelineView.js';
import { DiffView } from './views/DiffView.js';

type View =
  | { view: 'list' }
  | { view: 'timeline'; depId: string }
  | { view: 'diff'; depId: string; diffId: string };

const queryClient = new QueryClient();

export function App() {
  const [view, setView] = useState<View>({ view: 'list' });

  return (
    <QueryClientProvider client={queryClient}>
      <header className="masthead">
        <h1>Tremurex</h1>
        <span className="tagline">structural drift monitor</span>
      </header>
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
    </QueryClientProvider>
  );
}
