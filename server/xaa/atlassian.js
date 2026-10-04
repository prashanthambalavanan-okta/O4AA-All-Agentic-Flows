import { config } from '../config.js';

// NHI · Secrets (Atlassian): T3 trades the vaulted client id/secret for an Atlassian token,
// T4 reads the Scrum board's issues. These are hand-built steps (not captureFormPost /
// captureGet) so the client secret and bearer token are masked in the UI.

const mask = (v = '') => (v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-4)}` : '••••');

async function doFetch(url, init) {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: { error: 'network_error', error_description: err.message } };
  }
}

// Vaulted secret → { clientId, clientSecret }; accepts named fields or username/password.
function pickClient(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const vals = Object.values(raw);
  const clientId = raw.client_id ?? raw.clientId ?? raw.username ?? vals[0];
  const clientSecret = raw.client_secret ?? raw.clientSecret ?? raw.password ?? vals[1];
  return clientId && clientSecret ? { clientId: String(clientId), clientSecret: String(clientSecret) } : null;
}

/** T3 — client_credentials at Atlassian using the vaulted client id/secret. */
export async function requestAtlassianToken(rawSecret) {
  const { oauthTokenUrl, audience, scope } = config.atlassian;
  const client = pickClient(rawSecret);
  const reqBody = { grant_type: 'client_credentials', client_id: client?.clientId, client_secret: client?.clientSecret, audience };
  if (scope) reqBody.scope = scope;
  const shown = { ...reqBody, client_secret: '••••••••' };

  const { status, body } = client
    ? await doFetch(oauthTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(reqBody),
      })
    : { status: 0, body: { error: 'invalid_secret', error_description: 'The vaulted secret has no client id / client secret pair.' } };

  const ok = status >= 200 && status < 300 && !!body?.access_token;
  const step = {
    id: 'T3',
    title: 'Get Atlassian Token',
    badge: 'Atlassian',
    from: 'Agent',
    to: 'Atlassian',
    ok,
    request: { method: 'POST', url: oauthTokenUrl, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(shown, null, 2) },
    response: { status, headers: {}, body: ok ? { ...body, access_token: mask(body.access_token) } : body },
    token: null,
    code: `curl -X POST '${oauthTokenUrl}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(shown)}'`,
  };
  return { step, ok, accessToken: ok ? body.access_token : null };
}

/** T4 — read the Scrum board's issues from the Jira Software (Agile) API. */
export async function readScrumBoardIssues(accessToken, stepId = 'T4') {
  const { apiBaseUrl, boardId, maxResults } = config.atlassian;
  let cloudId = config.atlassian.cloudId;
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const shownHeaders = { ...headers, Authorization: `Bearer ${mask(accessToken)}` };

  if (!boardId) return { ok: false, error: 'Atlassian flow is not configured — set ATLASSIAN_BOARD_ID.', step: notConfigured('ATLASSIAN_BOARD_ID', stepId) };

  // ATLASSIAN_CLOUD_ID must be the site's UUID. If it's blank, or looks like the site
  // name (e.g. "acme" / "acme.atlassian.net" — easy to paste from the URL), resolve the
  // UUID from the token's accessible-resources.
  const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '');
  if (!isUuid(cloudId)) {
    const site = (cloudId || '').replace(/^https?:\/\//, '').replace(/\.atlassian\.net.*$/, '');
    const r = await doFetch(`${apiBaseUrl}/oauth/token/accessible-resources`, { headers });
    const sites = Array.isArray(r.body) ? r.body : [];
    const match = site ? sites.find((x) => x.url?.includes(`//${site}.atlassian.net`) || x.name === site) : null;
    cloudId = (match || (site ? null : sites[0]))?.id;
  }
  if (!cloudId) return { ok: false, error: 'Could not find the Jira site for this token — the Atlassian credential may not have access to the site, or ATLASSIAN_CLOUD_ID is wrong.', step: notConfigured('ATLASSIAN_CLOUD_ID', stepId) };

  const url = `${apiBaseUrl}/ex/jira/${cloudId}/rest/agile/1.0/board/${boardId}/issue?maxResults=${maxResults}&fields=summary,status,assignee`;
  const { status, body } = await doFetch(url, { headers });
  const ok = status >= 200 && status < 300;
  const step = {
    id: stepId,
    title: 'Read Scrum Board Issues',
    badge: 'Jira',
    from: 'Agent',
    to: 'Atlassian Jira API',
    ok,
    request: { method: 'GET', url, headers: shownHeaders, body: '' },
    response: { status, headers: {}, body },
    token: null,
    code: `curl '${url}' \\\n  -H 'Authorization: Bearer ${mask(accessToken)}' \\\n  -H 'Accept: application/json'`,
  };
  return { step, ok, issues: ok ? body.issues || [] : [] };
}

function notConfigured(varName, stepId = 'T4') {
  return {
    id: stepId, title: 'Read Scrum Board Issues', badge: 'Jira', from: 'Agent', to: 'Atlassian Jira API', ok: false,
    request: { method: 'GET', url: '', headers: {}, body: '' },
    response: { status: 0, headers: {}, body: { error: 'not_configured', error_description: `Set ${varName}.` } },
    token: null, code: '',
  };
}

export function summarizeBoardIssues(issues) {
  if (!issues.length) return 'No tasks found on the Scrum board.';
  const lines = issues.map(
    (i) => `• ${i.key} — ${i.fields?.summary ?? ''} [${i.fields?.status?.name ?? 'unknown'}]${i.fields?.assignee ? ` · ${i.fields.assignee.displayName}` : ''}`
  );
  return `Scrum board tasks (${issues.length}):\n\n${lines.join('\n')}`;
}

// Vaulted secret → Atlassian access token; accepts access_token/token or a single value.
export function pickAccessToken(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw.access_token ?? raw.accessToken ?? raw.token ?? Object.values(raw)[0];
  return v ? String(v) : null;
}
