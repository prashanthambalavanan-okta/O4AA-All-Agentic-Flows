import React, { useState } from 'react';
import JsonView from './JsonView.jsx';
import TokenView from './TokenView.jsx';
import CodeBlock from './CodeBlock.jsx';
import { jwtParamsFromBody } from '../decodeJwt.js';
import { describedParamsFromBody } from '../paramGlossary.js';
import { splitUrl, decodedRequestBody, decodedResponseBody, decodedHeaders } from '../decodeView.js';

const TABS = ['Request', 'Response', 'Token', 'Code'];

// Pretty-print a form-urlencoded body as one param per line (matches the screenshot).
function formatBody(body, headers) {
  const ct = headers?.['Content-Type'] || headers?.['content-type'] || '';
  if (typeof body === 'string' && ct.includes('x-www-form-urlencoded')) {
    return body.split('&').join('\n&');
  }
  return body;
}

// Which highlighter CodeBlock should apply to the BODY, based on Content-Type.
function bodyHighlightMode(headers) {
  const ct = (headers?.['Content-Type'] || headers?.['content-type'] || '').toLowerCase();
  if (ct.includes('x-www-form-urlencoded')) return 'form';
  if (ct.includes('application/json')) return 'json';
  return undefined;
}

// Okta returns x-okta-request-id on every API response; it is the System Log's
// transaction.id. The Admin Console lives on the "-admin" host of the org the request
// went to (oktaforai.oktapreview.com → oktaforai-admin.oktapreview.com). Custom domains
// can't be mapped to their admin host, so no link is shown for them.
const OKTA_HOST = /^([a-z0-9-]+?)(-admin)?\.(okta|oktapreview|okta-emea|okta-gov|okta-mil|trexcloud)\.com$/i;
export function oktaSystemLogUrl(step) {
  const headers = step.response?.headers || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'x-okta-request-id');
  const requestId = key && headers[key];
  if (!requestId) return null;
  let host;
  try {
    host = new URL(step.request.url).hostname;
  } catch {
    return null;
  }
  const m = host.match(OKTA_HOST);
  if (!m) return null;
  const search = encodeURIComponent(`transaction.id eq "${requestId}"`).replace(/%20/g, '+');
  return `https://${m[1]}-admin.${m[3]}.com/report/system_log_2?search=${search}`;
}

function MethodPill({ method }) {
  return <span className="method-pill">{method}</span>;
}

// Collapsible section — used for HEADERS, collapsed by default across all flows.
function Collapsible({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapsible">
      <button className="collapsible-head" onClick={() => setOpen((o) => !o)}>
        <span className={`chev ${open ? 'open' : ''}`}>▸</span> {title}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export default function StepCard({ step, expanded, onSelect }) {
  const [tab, setTab] = useState('Request');
  // Decoded (default) URL-decodes params and expands JWTs; Raw shows the exact wire bytes.
  const [decoded, setDecoded] = useState(true);
  const url = decoded ? splitUrl(step.request.url) : { base: step.request.url, query: null };
  const systemLogUrl = oktaSystemLogUrl(step);

  return (
    <div className={`card ${step.ok ? 'card-ok' : 'card-fail'} ${expanded ? 'card-open' : ''}`}>
      <div className="card-rail" />
      {/* A div, not a <button>: the System Log link can't be nested inside a button. */}
      <div
        className="card-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        <span className={`card-check ${step.ok ? 'ok' : 'fail'}`}>{step.ok ? '✓' : '!'}</span>
        <span className="card-title">{step.title}</span>
        <span className="card-route">
          {step.from} <span className="arrow">›</span> {step.to}
        </span>
        {systemLogUrl && (
          <a
            className="card-okta-logs"
            href={systemLogUrl}
            target="_blank"
            rel="noreferrer"
            title="Open this request in the Okta System Log (filtered by its x-okta-request-id)"
            onClick={(e) => e.stopPropagation()}
          >
            View Okta system logs ↗
          </a>
        )}
        <span className={`card-badge badge-${step.badge.replace(/\s+/g, '-').toLowerCase()}`}>
          {step.badge}
        </span>
      </div>

      {expanded && (
        <div className="card-body">
          <div className="tabs-row">
            <div className="tabs">
              {TABS.map((t) => (
                <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>
            {(tab === 'Request' || tab === 'Response') && (
              <div className="view-toggle" role="group" aria-label="Body view">
                <button className={decoded ? 'active' : ''} onClick={() => setDecoded(true)}>Decoded</button>
                <button className={!decoded ? 'active' : ''} onClick={() => setDecoded(false)}>Raw</button>
              </div>
            )}
          </div>
          {step.note && <div className="step-note">{step.note}</div>}

          {tab === 'Request' && (
            <div className="tab-panel">
              <div className="url-row">
                <MethodPill method={step.request.method} />
                <span className="url">{url.base}</span>
              </div>
              {url.query && (
                <div className="query-params">
                  <h4>QUERY PARAMETERS</h4>
                  <CodeBlock text={url.query} label="QUERY" mode="form" />
                </div>
              )}
              <Collapsible title="HEADERS" defaultOpen={!!step.expandHeaders}>
                <JsonView value={step.request.headers} />
              </Collapsible>
              <h4>BODY</h4>
              <CodeBlock
                text={String(
                  decoded
                    ? decodedRequestBody(step.request.body, step.request.headers)
                    : formatBody(step.request.body, step.request.headers)
                )}
                label="BODY"
                mode={bodyHighlightMode(step.request.headers)}
              />
              {(() => {
                const jwts = jwtParamsFromBody(step.request.body);
                if (!jwts.length) return null;
                return (
                  <Collapsible title={`DECODED JWT PARAMETERS (${jwts.length})`} defaultOpen>
                    {jwts.map((j) => (
                      <Collapsible key={j.name} title={j.name}>
                        <div className="token-section">
                          <h4>HEADER</h4>
                          <JsonView value={j.decoded.header} />
                        </div>
                        <div className="token-section">
                          <h4>PAYLOAD</h4>
                          <JsonView value={j.decoded.payload} />
                        </div>
                      </Collapsible>
                    ))}
                  </Collapsible>
                );
              })()}
              {(() => {
                const params = describedParamsFromBody(step.request.body, step.request.headers);
                if (!params.length) return null;
                return (
                  <Collapsible title={`PARAMETER REFERENCE (${params.length})`}>
                    <dl className="param-ref">
                      {params.map((p) => (
                        <div key={p.name} className="param-ref-row">
                          <dt>{p.name}</dt>
                          <dd>{p.description}</dd>
                        </div>
                      ))}
                    </dl>
                  </Collapsible>
                );
              })()}
            </div>
          )}

          {tab === 'Response' && (
            <div className="tab-panel">
              <div className="status-row">
                <span className={`status-pill ${step.ok ? 'ok' : 'fail'}`}>
                  {step.response.status || '—'}
                </span>
              </div>
              <Collapsible title="HEADERS">
                <JsonView value={decoded ? decodedHeaders(step.response.headers) : step.response.headers} />
              </Collapsible>
              <h4>BODY</h4>
              <JsonView value={decoded ? decodedResponseBody(step.response.body) : step.response.body} />
            </div>
          )}

          {tab === 'Token' && (
            <div className="tab-panel">
              <TokenView token={step.token} />
            </div>
          )}

          {tab === 'Code' && (
            <div className="tab-panel">
              <CodeBlock text={step.code} label="cURL" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
