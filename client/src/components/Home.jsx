import React from 'react';
import { FLOWS } from '../flows.js';

const SECTIONS = [
  {
    eyebrow: 'Single Agent',
    title: 'Human Identity Use Case',
    blurb: 'One agent acting on behalf of a signed-in human to reach a protected resource.',
    flows: ['xaa', 'xaa-webapp', 'hi-saml', 'secrets', 'service-account', 'sts-github'],
  },
  {
    eyebrow: 'Single Agent',
    title: 'Non-Human Identity Use Case',
    blurb: 'One agent acting as a service identity, with no human login, to reach a protected resource.',
    flows: ['client-credentials', 'secrets-atlassian', 'secrets-atlassian-token'],
  },
  {
    eyebrow: 'Agent → Agent',
    title: 'Agent-to-Agent Use Cases',
    blurb: 'One agent delegates to another agent, chaining id-JAGs across authorization servers.',
    flows: ['hi-a2a', 'nhi-a2a'],
  },
];

// Party of the agent and of the resource it reaches: first-party (same org as
// the IdP) or third-party (an external provider, e.g. GitHub behind the STS
// broker). Flows default to 1P/1P; a flow overrides via agentParty/resourceParty.
const PARTY_LABEL = { '1P': 'First party', '3P': 'Third party' };

function Party({ party, kind }) {
  return (
    <span className={`party party-${party.toLowerCase()}`} title={`${PARTY_LABEL[party]} ${kind.toLowerCase()}`}>
      {party} {kind}
    </span>
  );
}

function FlowCard({ f, onSelect }) {
  // cardSuffix (e.g. "(Login as agent)") renders on its own line below the main
  // title; other flow names are shown as-is.
  const title = f.cardSuffix ? f.name.replace(f.cardSuffix, '').trim() : f.name;
  return (
    <button className="flow-card" style={{ '--accent': f.accent }} onClick={() => onSelect(f.id)}>
      <span className="flow-accent" />
      <h3>{title}</h3>
      {f.cardSuffix && <div className="flow-subtitle">{f.cardSuffix}</div>}
      {f.note && <div className="flow-note">{f.note}</div>}
      <div className="flow-tagline">{f.tagline}</div>
      <p>{f.description}</p>
      <div className="flow-foot">
        <span className="flow-parties">
          <Party party={f.agentParty || '1P'} kind="Agent" />
          <Party party={f.resourceParty || '1P'} kind="Resource" />
        </span>
        <span className="flow-go">Open →</span>
      </div>
      {f.warning && <div className="flow-warning">{f.warning}</div>}
      {f.recommended && <div className="flow-recommended">{f.recommended}</div>}
    </button>
  );
}

export default function Home({ onSelect }) {
  return (
    <div className="home">
      <div className="home-head">
        <h1>Okta for AI - Use Case Patterns</h1>
        <p>Each use case logs in once (T1), then walks the agent’s token exchange step by step.</p>
      </div>

      {SECTIONS.map((s) => {
        const flows = s.flows.map((id) => FLOWS[id]).filter(Boolean);
        if (!flows.length) return null;
        return (
          <section key={s.title} className="home-section">
            <div className="section-head">
              <span className="section-eyebrow">{s.eyebrow}</span>
              <div className="section-line">
                <h2>{s.title}</h2>
                <span className="section-dash">-</span>
                <p>{s.blurb}</p>
              </div>
            </div>
            <div className="home-grid">
              {flows.map((f) => (
                <FlowCard key={f.id} f={f} onSelect={onSelect} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
