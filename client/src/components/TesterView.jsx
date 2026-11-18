import React, { useEffect, useId, useRef, useState } from 'react';
import StepCard from './StepCard.jsx';
import { getTesterFlow, runTesterStep, getTesterLoginResult } from '../api.js';

// Tester tab — run the flow one step at a time with your own values (client ids, keys,
// secrets, auth servers, audiences, scopes, resources, MCP / API URLs). Each step's
// outputs fill the bound (↳) fields of the steps after it.

const AUTH_METHODS = [
  { value: 'private_key_jwt', label: 'Private key (private_key_jwt)' },
  { value: 'client_secret_basic', label: 'Client secret · Basic header' },
  { value: 'client_secret_post', label: 'Client secret · POST body' },
  { value: 'none', label: 'Client ID only (public client)' },
];

const lastKey = (flow) => `tester:last:${flow}`;
const profilesKey = (flow) => `tester:profiles:${flow}`;
const stashKey = (flow) => `tester:stash:${flow}`;
const REMEMBER_KEY = 'tester:rememberSecrets';

const readJson = (store, key, fallback) => {
  try {
    const v = JSON.parse(store.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

function defaultsFor(steps) {
  const out = {};
  for (const s of steps) {
    out[s.id] = {
      fields: Object.fromEntries(s.fields.map((f) => [f.key, f.default ?? ''])),
      auth: s.auth ? { ...s.auth.default } : {},
    };
  }
  return out;
}

/** Overlay saved values onto defaults, keeping only keys the current schema knows. */
function mergeSaved(base, saved) {
  if (!saved) return base;
  const out = {};
  for (const [id, v] of Object.entries(base)) {
    const sv = saved[id] || {};
    out[id] = {
      fields: { ...v.fields, ...pickKnown(sv.fields, v.fields) },
      auth: { ...v.auth, ...pickKnown(sv.auth, v.auth) },
    };
  }
  return out;
}
const pickKnown = (src = {}, known = {}) => Object.fromEntries(Object.entries(src).filter(([k]) => k in known));

/** Drop secrets and chain values (tokens) before persisting, unless asked to keep them. */
function persistable(steps, values, keepSecrets) {
  if (keepSecrets) return values;
  const out = {};
  for (const s of steps) {
    const v = values[s.id];
    if (!v) continue;
    const fields = { ...v.fields };
    for (const f of s.fields) if (f.secret || f.bind || (s.kind === 'subject' && f.key === 'token')) delete fields[f.key];
    const { privateKeyPem, clientSecret, ...auth } = v.auth || {};
    out[s.id] = { fields, auth };
  }
  return out;
}

function shown(showIf, fields) {
  if (!showIf) return true;
  return Object.entries(showIf).every(([k, want]) => (Array.isArray(want) ? want.includes(fields[k]) : fields[k] === want));
}

/** First available "T2.access_token"-style source among a field's binds. */
function resolveBind(bind, results) {
  for (const ref of bind || []) {
    const i = ref.indexOf('.');
    const out = results[ref.slice(0, i)]?.outputs?.[ref.slice(i + 1)];
    if (out != null && out !== '') return { ref, value: out };
  }
  return null;
}

/** Fill bound fields from results. `onlyFrom` limits it to binds on one source step. */
function applyBinds(steps, values, results, onlyFrom) {
  const next = { ...values };
  for (const s of steps) {
    for (const f of s.fields) {
      if (!f.bind) continue;
      if (onlyFrom && !f.bind.some((b) => b.startsWith(`${onlyFrom}.`))) continue;
      const hit = resolveBind(f.bind, results);
      if (hit) next[s.id] = { ...next[s.id], fields: { ...next[s.id].fields, [f.key]: hit.value } };
    }
  }
  return next;
}

const short = (v) => {
  const s = String(v ?? '');
  return s.length > 64 ? `${s.slice(0, 40)}…${s.slice(-16)}` : s;
};

function Field({ f, value, onChange, onApply, boundFrom }) {
  const id = useId();
  let input;
  if (f.type === 'select') {
    input = (
      <select
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          const opt = f.options.find((o) => o.value === e.target.value);
          if (opt?.apply) onApply(opt.apply);
        }}
      >
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (f.type === 'textarea') {
    input = <textarea rows={f.rows || 3} value={value} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  } else {
    input = (
      <>
        <input
          type={f.secret ? 'password' : 'text'}
          value={value}
          placeholder={f.placeholder}
          list={f.type === 'combo' ? id : undefined}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        {f.type === 'combo' && (
          <datalist id={id}>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </datalist>
        )}
      </>
    );
  }
  return (
    <label className="tf-row">
      <span className="tf-label">
        {f.label}
        {f.bind && (
          <span className={`tf-bind ${boundFrom ? 'on' : ''}`} title={`Filled automatically from ${f.bind.join(' or ')}`}>
            ↳ {boundFrom || f.bind[0]}
          </span>
        )}
      </span>
      {input}
      {f.help && <span className="tf-help">{f.help}</span>}
    </label>
  );
}

function AuthBlock({ step, auth, onChange }) {
  const set = (k) => (v) => onChange({ ...auth, [k]: v });
  const m = auth.method;
  return (
    <fieldset className="tf-auth">
      <legend>{step.authLabel || 'Client authentication'}</legend>
      <label className="tf-row">
        <span className="tf-label">Method</span>
        <select value={m} onChange={(e) => set('method')(e.target.value)}>
          {AUTH_METHODS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="tf-row">
        <span className="tf-label">client_id</span>
        <input value={auth.clientId || ''} onChange={(e) => set('clientId')(e.target.value)} spellCheck={false} />
      </label>
      {m === 'private_key_jwt' && (
        <>
          <label className="tf-row">
            <span className="tf-label">Private key</span>
            <select value={auth.keySource || 'file'} onChange={(e) => set('keySource')(e.target.value)}>
              <option value="file">Key file on the server</option>
              <option value="pem">Paste PEM</option>
            </select>
          </label>
          {auth.keySource === 'pem' ? (
            <label className="tf-row">
              <span className="tf-label">PEM (RSA, PKCS#8 or PKCS#1)</span>
              <textarea
                rows={5}
                value={auth.privateKeyPem || ''}
                onChange={(e) => set('privateKeyPem')(e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----"
                spellCheck={false}
              />
              <span className="tf-help">Used to sign this request only — never written to disk.</span>
            </label>
          ) : (
            <label className="tf-row">
              <span className="tf-label">Key file (inside this project)</span>
              <input value={auth.privateKeyFile || ''} onChange={(e) => set('privateKeyFile')(e.target.value)} spellCheck={false} />
            </label>
          )}
          <label className="tf-row">
            <span className="tf-label">kid</span>
            <input value={auth.kid || ''} placeholder="(omit from JWT header)" onChange={(e) => set('kid')(e.target.value)} spellCheck={false} />
          </label>
          <label className="tf-row">
            <span className="tf-label">Assertion aud</span>
            <input value={auth.assertionAudience || ''} placeholder="blank = the token URL" onChange={(e) => set('assertionAudience')(e.target.value)} spellCheck={false} />
          </label>
          <label className="tf-check">
            <input type="checkbox" checked={!!auth.sendClientId} onChange={(e) => set('sendClientId')(e.target.checked)} />
            Also send client_id in the body
          </label>
        </>
      )}
      {(m === 'client_secret_basic' || m === 'client_secret_post') && (
        <label className="tf-row">
          <span className="tf-label">client_secret</span>
          <input
            type="password"
            value={auth.clientSecret || ''}
            placeholder={step.auth?.hasSecretDefault ? 'blank = configured secret' : 'required'}
            onChange={(e) => set('clientSecret')(e.target.value)}
            autoComplete="new-password"
          />
        </label>
      )}
    </fieldset>
  );
}

function Outputs({ outputs }) {
  const entries = Object.entries(outputs || {});
  if (!entries.length) return null;
  return (
    <div className="tf-outputs">
      <h4>Outputs</h4>
      {entries.map(([k, v]) => (
        <div key={k} className="tf-output">
          <code className="tf-output-key">{k}</code>
          <code className="tf-output-val" title={String(v)}>
            {short(v)}
          </code>
          <button className="btn-link" onClick={() => navigator.clipboard?.writeText(String(v))}>
            Copy
          </button>
        </div>
      ))}
    </div>
  );
}

const copy = (v) => navigator.clipboard?.writeText(v);

/** Fresh login setup: the callback URIs to register, and on which Okta apps. */
function RedirectSetup({ schema }) {
  const [open, setOpen] = useState(false);
  const uris = schema.redirectUris || [schema.redirectUri];
  const apps = schema.loginApps || [];
  const current = apps.filter((a) => a.current);
  return (
    <div className="tester-redirects">
      <div className="tester-redirects-head">
        <strong>Fresh login redirect URIs</strong>
        <span className="tf-help">
          Add these as <em>Sign-in redirect URIs</em> on the Okta app you log in with
          {current.length ? (
            <>
              {' '}
              (this flow: <strong>{current.map((a) => a.label).join(', ')}</strong>)
            </>
          ) : null}
          .
        </span>
      </div>
      {uris.map((u) => (
        <div key={u} className="tester-redirect-row">
          <code>{u}</code>
          {u === schema.redirectUri && <span className="tf-bind on">this host</span>}
          <button className="btn-link" onClick={() => copy(u)}>
            Copy
          </button>
        </div>
      ))}
      <button className="btn-link" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} all apps that need them ({apps.length})
      </button>
      {open && (
        <table className="tester-apps">
          <thead>
            <tr>
              <th>App</th>
              <th>Client ID</th>
              <th>Used by</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.env} className={a.current ? 'current' : ''}>
                <td>
                  {a.label}
                  <div className="tf-help">{a.env}</div>
                </td>
                <td>
                  <code>{a.clientId}</code>
                  {a.cimd && (
                    <div className="tf-help">
                      CIMD: no console setting. Add the URIs to <code>redirect_uris</code> in the metadata document at this URL.
                    </div>
                  )}
                </td>
                <td className="tf-help">{a.flows.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TesterStep({ step, value, result, busy, disabled, open, onToggle, onChange, onRun, results }) {
  const [activeCard, setActiveCard] = useState(null);
  const fields = value.fields;
  const status = busy ? 'running' : result ? (result.ok ? 'ok' : 'fail') : 'idle';
  const setField = (k, v) => onChange({ ...value, fields: { ...fields, [k]: v } });
  const applyFields = (patch) => onChange({ ...value, fields: { ...fields, ...patch } });

  return (
    <div className={`tester-step tester-${status}`}>
      <div className="tester-step-head">
        <button className="tester-step-toggle" onClick={onToggle}>
          <span className={`chev ${open ? 'open' : ''}`}>▸</span>
          <strong>{step.id}</strong>
          <span className="tester-step-title">{step.title}</span>
          <span className="card-route">
            {step.from} <span className="arrow">›</span> {step.to}
          </span>
        </button>
        <span className={`tester-status tester-status-${status}`}>
          {status === 'running' ? 'Running…' : status === 'ok' ? '✓ OK' : status === 'fail' ? '! Failed' : 'Not run'}
        </span>
        <button className="btn-primary btn-small" disabled={disabled} onClick={onRun}>
          Run
        </button>
      </div>

      {open && (
        <div className="tester-step-body">
          <div className="tf-grid">
            {step.fields
              .filter((f) => shown(f.showIf, fields))
              .map((f) => (
                <Field
                  key={f.key}
                  f={f}
                  value={fields[f.key] ?? ''}
                  onChange={(v) => setField(f.key, v)}
                  onApply={applyFields}
                  boundFrom={resolveBind(f.bind, results)?.ref}
                />
              ))}
          </div>
          {step.auth && shown(step.authShowIf, fields) && (
            <AuthBlock step={step} auth={value.auth} onChange={(auth) => onChange({ ...value, auth })} />
          )}
        </div>
      )}

      {result && (
        <div className="tester-result">
          {result.message && <div className={`tester-message ${result.ok ? '' : 'error'}`}>{result.message}</div>}
          <Outputs outputs={result.outputs} />
          {(result.steps || []).map((s, i) => (
            <StepCard
              key={`${s.id}-${i}`}
              step={s}
              expanded={activeCard === i}
              onSelect={() => setActiveCard(activeCard === i ? null : i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function TesterView({ flow }) {
  const [schema, setSchema] = useState(null);
  const [error, setError] = useState(null);
  const [values, setValues] = useState({});
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState({});
  const [remember, setRemember] = useState(() => localStorage.getItem(REMEMBER_KEY) === 'true');
  const [profiles, setProfiles] = useState(() => readJson(localStorage, profilesKey(flow.id), {}));
  const [profile, setProfile] = useState('');
  const valuesRef = useRef(values);
  const resultsRef = useRef(results);
  valuesRef.current = values;
  resultsRef.current = results;

  // Load the flow's steps, then restore: saved values → pre-login stash → login result.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getTesterFlow(flow.id);
        if (cancelled) return;
        let vals = mergeSaved(defaultsFor(s.steps), readJson(localStorage, lastKey(flow.id), null));
        let res = {};
        const stash = readJson(sessionStorage, stashKey(flow.id), null);
        if (stash) {
          sessionStorage.removeItem(stashKey(flow.id));
          vals = mergeSaved(vals, stash.values);
          res = stash.results || {};
        }
        const login = await getTesterLoginResult(flow.id).catch(() => ({}));
        if (login?.result) res = { ...res, [login.result.stepId]: login.result };
        vals = applyBinds(s.steps, vals, res);
        setSchema(s);
        setValues(vals);
        setResults(res);
        setOpen(Object.fromEntries(s.steps.map((st, i) => [st.id, i === 0 || !!login?.result])));
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flow.id]);

  // Remember the last values per flow (secrets/tokens only if asked).
  useEffect(() => {
    if (!schema) return;
    localStorage.setItem(lastKey(flow.id), JSON.stringify(persistable(schema.steps, values, remember)));
  }, [values, remember, schema]);

  if (error) return <div className="tester-empty">Tester unavailable: {error}</div>;
  if (!schema) return <div className="tester-empty">Loading the Tester…</div>;
  const steps = schema.steps;

  async function run(stepId, vals = valuesRef.current, res = resultsRef.current) {
    setBusy(stepId);
    try {
      const r = await runTesterStep(flow.id, stepId, vals[stepId]);
      if (r.redirect) {
        // Fresh login: keep the whole form (including secrets) for this tab only, then go.
        sessionStorage.setItem(stashKey(flow.id), JSON.stringify({ values: vals, results: res }));
        window.location.href = r.redirect;
        return { stop: true };
      }
      const nextResults = { ...res, [stepId]: r };
      const nextValues = r.ok ? applyBinds(steps, vals, nextResults, stepId) : vals;
      setResults(nextResults);
      setValues(nextValues);
      return { ok: r.ok, values: nextValues, results: nextResults };
    } catch (err) {
      const nextResults = { ...res, [stepId]: { ok: false, steps: [], outputs: {}, message: err.message } };
      setResults(nextResults);
      return { ok: false, values: vals, results: nextResults };
    } finally {
      setBusy(null);
    }
  }

  async function runAll(fromIndex = 0) {
    let vals = valuesRef.current;
    let res = resultsRef.current;
    for (const s of steps.slice(fromIndex)) {
      const r = await run(s.id, vals, res);
      if (r.stop || !r.ok) return;
      vals = r.values;
      res = r.results;
    }
  }

  function reset() {
    localStorage.removeItem(lastKey(flow.id));
    setValues(defaultsFor(steps));
    setResults({});
    setProfile('');
  }

  function saveProfile() {
    const name = window.prompt('Profile name', profile || '');
    if (!name) return;
    const next = { ...profiles, [name]: persistable(steps, values, remember) };
    localStorage.setItem(profilesKey(flow.id), JSON.stringify(next));
    setProfiles(next);
    setProfile(name);
  }

  function loadProfile(name) {
    setProfile(name);
    if (!name || !profiles[name]) return;
    setValues(applyBinds(steps, mergeSaved(defaultsFor(steps), profiles[name]), results));
  }

  function deleteProfile() {
    if (!profile) return;
    const { [profile]: _, ...rest } = profiles;
    localStorage.setItem(profilesKey(flow.id), JSON.stringify(rest));
    setProfiles(rest);
    setProfile('');
  }

  const hasLogin = steps.some((s) => s.kind === 'subject' && s.auth);

  return (
    <div className="tester">
      <div className="tester-toolbar">
        <button className="btn-primary" disabled={!!busy} onClick={() => runAll(0)}>
          Run all ▶
        </button>
        <button className="btn-outline btn-small" disabled={!!busy} onClick={reset}>
          Reset to .env defaults
        </button>
        <span className="tester-spacer" />
        <select value={profile} onChange={(e) => loadProfile(e.target.value)} title="Saved value sets for this flow">
          <option value="">Profiles…</option>
          {Object.keys(profiles).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="btn-outline btn-small" onClick={saveProfile}>
          Save
        </button>
        <button className="btn-outline btn-small" disabled={!profile} onClick={deleteProfile}>
          Delete
        </button>
        <label className="tf-check" title="Store pasted keys, secrets and tokens in this browser's localStorage">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => {
              localStorage.setItem(REMEMBER_KEY, String(e.target.checked));
              setRemember(e.target.checked);
            }}
          />
          Remember secrets
        </label>
      </div>
      <p className="tester-intro">
        Values start from this app’s .env config. Edit any of them: client IDs, keys or secrets, authorization servers, audiences,
        scopes, resources, and the MCP / API URL. Fields marked <span className="tf-bind on">↳</span> fill in automatically
        from an earlier step’s outputs. Run one step at a time, or use Run all.
      </p>
      {hasLogin && <RedirectSetup schema={schema} />}

      {steps.map((s, i) => (
        <TesterStep
          key={s.id}
          step={s}
          value={values[s.id]}
          result={results[s.id]}
          results={results}
          busy={busy === s.id}
          disabled={!!busy}
          open={!!open[s.id]}
          onToggle={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}
          onChange={(v) => setValues((all) => ({ ...all, [s.id]: v }))}
          onRun={() => run(s.id)}
        />
      ))}
    </div>
  );
}
