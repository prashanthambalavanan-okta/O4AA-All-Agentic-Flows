export async function getMe() {
  const res = await fetch('/api/me', { credentials: 'include' });
  return res.json();
}

export async function ask(question, flow = 'xaa') {
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ question, flow }),
  });
  if (res.status === 401) {
    // token_expired: the server already ended the session — the caller sends the user
    // back to the login page. not_authenticated: the session is gone for another reason.
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error_description || body.error || 'not_authenticated');
    err.code = body.error || 'not_authenticated';
    throw err;
  }
  return res.json();
}

export async function revokeSts() {
  const res = await fetch('/api/sts/revoke', {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
}

// Build a login URL. `opts.prompt` (e.g. 'login') is forwarded to Okta's /authorize as the
// OIDC prompt parameter — the Force login toggle uses it to re-authenticate even when an
// Okta session already exists.
function loginUrl(path, flowId, opts = {}) {
  const q = new URLSearchParams();
  if (flowId) q.set('flow', flowId);
  if (opts.prompt) q.set('prompt', opts.prompt);
  const qs = q.toString();
  return `${path}${qs ? `?${qs}` : ''}`;
}

// The Login page binds login directly to onClick, so ignore a click event passed as flowId.
const asFlowId = (v) => (typeof v === 'string' ? v : undefined);

export function login(flowId, opts) {
  window.location.href = loginUrl('/api/login', asFlowId(flowId), opts);
}

export function a2aLogin(flowId, opts) {
  window.location.href = loginUrl('/api/a2a/login', flowId, opts);
}

export function samlLogin(flowId) {
  window.location.href = loginUrl('/api/saml/login', flowId);
}

export function webappLogin(flowId, opts) {
  window.location.href = loginUrl('/api/webapp/login', flowId, opts);
}

// Authentication Patterns — each agent runs its own login (it is the OIDC client).
export function authpLogin(pattern, flowId, opts) {
  window.location.href = loginUrl(`/api/authp/${encodeURIComponent(pattern)}/login`, flowId, opts);
}

// Unauthenticated — same endpoint an external cron/scheduler would hit directly.
export async function runScheduled(flow, tool) {
  const res = await fetch('/api/scheduler/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow, tool }),
  });
  return res.json();
}

// Local testing: submit a pasted SAML assertion (or base64 SAMLResponse) to the server.
export async function pasteSamlAssertion(assertion) {
  const res = await fetch('/api/saml/paste', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ assertion }),
  });
  return res.json();
}
