import React, { useEffect, useState } from 'react';
import StepCard from './StepCard.jsx';
import { getAtlassianRegistration, registerAtlassianAgent } from '../api.js';

// HI - Cross-App Access (Atlassian) — one-time prerequisite, collapsed above the steps.
// Shows the recorded Dynamic Client Registration request/response (P0) that produced the
// client_id / client_secret T3 presents with the id-JAG.
export default function AtlassianDcrPanel() {
  const [open, setOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(true);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getAtlassianRegistration()
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, []);

  async function register(force) {
    if (force && !window.confirm('Re-registering creates a NEW Atlassian client_id. You must then update the Atlassian resource in Okta (and ATLASSIAN_XAA_CLIENT_ID/_SECRET if you set them). Continue?')) return;
    setBusy(true);
    setError(null);
    try {
      const r = await registerAtlassianAgent({ force });
      if (r.error) setError(r.error_description || r.error);
      setStatus((s) => ({ ...s, ...r }));
      setOpen(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const registered = !!status?.registered;
  const when = status?.registeredAt ? new Date(status.registeredAt).toLocaleString() : null;
  const headline = !status
    ? 'checking…'
    : registered
      ? `✓ Registered${when ? ` on ${when}` : ''}`
      : '✗ Not registered';

  return (
    <div className={`prereq ${registered ? 'prereq-ok' : 'prereq-todo'}`}>
      <button className="prereq-head" onClick={() => setOpen((o) => !o)}>
        <span className={`chev ${open ? 'open' : ''}`}>▸</span>
        <span className="prereq-eyebrow">Prerequisite</span>
        <span className="prereq-title">One-time Dynamic Client Registration with Atlassian</span>
        <span className="prereq-status">{headline}</span>
      </button>

      {open && (
        <div className="prereq-body">
          <p className="prereq-text">
            Atlassian only accepts agents registered through <strong>Dynamic Client Registration</strong> (RFC 7591).
            The agent registers once at <code>{status?.registrationUrl || '<ATLASSIAN_XAA_ISSUER>/dcr/register'}</code>;
            the returned <code>client_id</code> / <code>client_secret</code> are what <strong>T3</strong> sends with the
            id-JAG, and the <code>client_id</code> is configured on the Atlassian resource in Okta’s Cross-App Access settings.
          </p>

          {status && !status.configured && (
            <div className="prereq-warn">Set <code>ATLASSIAN_XAA_ISSUER</code> in .env to enable registration.</div>
          )}
          {registered && (
            <div className="prereq-meta">
              client_id <code>{status.clientId}</code> · credentials from{' '}
              {status.credentialSource === 'env' ? 'ATLASSIAN_XAA_CLIENT_ID / _SECRET' : 'keys/atlassian-dcr.json'}
            </div>
          )}
          {registered && !status.recordMatches && (
            <div className="prereq-warn">
              The recorded registration below is for a different client_id than the credentials in use.
            </div>
          )}
          {registered && !status.step && (
            <div className="prereq-warn">
              Credentials are configured but no registration record was found (registrations/atlassian-dcr.json).
              Run the registration once (locally: <code>node scripts/atlassian-dcr.mjs</code>) and commit the record to show it here.
            </div>
          )}
          {error && <div className="prereq-warn">{error}</div>}

          {status?.step && (
            <div className="cards prereq-cards">
              <StepCard step={status.step} expanded={cardOpen} onSelect={() => setCardOpen((o) => !o)} />
            </div>
          )}

          {status?.configured && (
            <div className="prereq-actions">
              {!registered ? (
                <button className="btn-primary" disabled={busy} onClick={() => register(false)}>
                  {busy ? 'Registering…' : 'Register agent with Atlassian (DCR)'}
                </button>
              ) : (
                <button className="btn-outline btn-small" disabled={busy} onClick={() => register(true)}>
                  {busy ? 'Registering…' : 'Re-register (new client_id)'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
