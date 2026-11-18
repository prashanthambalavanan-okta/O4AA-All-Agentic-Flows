import React, { useState } from 'react';
import SequenceView from './SequenceView.jsx';
import ArchitectureView from './ArchitectureView.jsx';
import AtlassianDcrPanel from './AtlassianDcrPanel.jsx';
import TesterView from './TesterView.jsx';
import { ARCHITECTURE } from '../architecture.js';

export default function SequencePane({ flow, steps, testerEnabled = false, initialTab = 'sequence' }) {
  const hasArchitecture = !!ARCHITECTURE[flow.id];
  const [tab, setTab] = useState(initialTab === 'tester' && !testerEnabled ? 'sequence' : initialTab);
  const tabs = [
    { id: 'sequence', label: 'Sequence' },
    ...(hasArchitecture ? [{ id: 'architecture', label: 'Architecture' }] : []),
    ...(testerEnabled ? [{ id: 'tester', label: 'Tester' }] : []),
  ];

  return (
    <section className="sequence-pane">
      {tabs.length > 1 && (
        <div className="pane-tabs">
          {tabs.map((t) => (
            <button key={t.id} className={`pane-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {tab === 'architecture' && hasArchitecture ? (
        <ArchitectureView flow={flow} />
      ) : tab === 'tester' && testerEnabled ? (
        <TesterView flow={flow} />
      ) : (
        <>
          {/* One-time prerequisite (collapsed) shown above the per-run steps. */}
          {flow.prerequisite === 'atlassian-dcr' && <AtlassianDcrPanel />}
          <SequenceView steps={steps} />
        </>
      )}
    </section>
  );
}
