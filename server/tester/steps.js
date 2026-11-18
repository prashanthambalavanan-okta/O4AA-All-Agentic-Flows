// Tester — generic step executors. Each flow in catalog.js is a list of steps of these
// kinds; the Tester tab posts one step's values at a time and gets back the captured
// request/response cards plus named outputs the next step binds to.
//
// Every executor returns { steps: [capturedStep…], outputs: { name: value }, ok }.
import { config } from '../config.js';
import { decodeJwt } from '../util/jwt.js';
import { validateAccessToken } from '../util/verifyToken.js';
import { callMcpTool } from '../mcp/inventoryServer.js';
import { buildMcpStep, buildBasicMcpStep } from '../xaa/mcpStep.js';
import { doFetch, mask, resolveCloudId } from '../xaa/atlassian.js';
import { parseRpc, toolPayload, readJiraIssues, createJiraIssue } from '../xaa/stsAtlassian.js';
import { tokenPost, failedStep } from './clientAuth.js';

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const MCP_PROTOCOL_VERSION = '2025-06-18';

export const TOKEN_TYPES = {
  id_token: 'urn:ietf:params:oauth:token-type:id_token',
  access_token: 'urn:ietf:params:oauth:token-type:access_token',
  refresh_token: 'urn:ietf:params:oauth:token-type:refresh_token',
  saml2: 'urn:ietf:params:oauth:token-type:saml2',
  id_jag: 'urn:ietf:params:oauth:token-type:id-jag',
  vaulted_secret: 'urn:okta:params:oauth:token-type:vaulted-secret',
  service_account: 'urn:okta:params:oauth:token-type:service-account',
  oauth_sts: 'urn:okta:params:oauth:token-type:oauth-sts',
};

// ── value helpers ──
const str = (v) => (v == null ? '' : String(v).trim());

/** Drop params left blank so they are omitted from the request rather than sent empty. */
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => str(v) !== ''));
}

/** "key=value" (or "Header: value") per line → object. */
function parseLines(text, sep = '=') {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

function parseJson(text, label) {
  if (!str(text)) return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { error: `${label} is not valid JSON: ${err.message}` };
  }
}

const meta = (def, extra = {}) => ({ id: def.id, title: def.title, badge: def.badge, from: def.from, to: def.to, ...extra });
const fail = (def, url, message, method) => ({ steps: [failedStep(meta(def), url, message, method)], outputs: {}, ok: false });

// ── subject token (T1 for user flows) ──
function subjectStep(def, f, session) {
  let token;
  let shortType;
  let loginSteps = null;
  const outputs = {};

  if (f.mode === 'paste') {
    token = str(f.token);
    shortType = f.tokenType || def.tokenType;
    if (!token) return fail(def, '', 'Paste a subject token, or switch the source to the current session.');
  } else {
    const s = def.fromSession(session) || {};
    token = s.token;
    shortType = def.tokenType;
    loginSteps = s.loginSteps;
    Object.assign(outputs, s.extra || {});
    if (!token) {
      return fail(def, '', `This session has no ${def.sessionLabel} yet — log in to this flow, paste a token, or use “Fresh login”.`);
    }
  }

  outputs.token = token;
  outputs.subject_token_type = TOKEN_TYPES[shortType] || shortType;
  outputs[shortType] = token;

  const isJwt = shortType !== 'saml2';
  const card = {
    id: def.id,
    title: f.mode === 'paste' ? 'Subject Token · pasted' : `Subject Token · ${def.sessionLabel} from current session`,
    badge: shortType === 'saml2' ? 'SAML Assertion' : shortType === 'id_token' ? 'ID Token' : 'Access Token',
    from: 'User',
    to: 'Agent',
    ok: true,
    request: { method: 'SESSION', url: f.mode === 'paste' ? '(pasted into the Tester)' : '(stored by this flow’s login)', headers: {}, body: '' },
    response: { status: 200, headers: {}, body: { token_type: outputs.subject_token_type, token } },
    token: isJwt ? decodeJwt(token) : null,
    code: '',
  };
  return { steps: loginSteps?.length && f.mode !== 'paste' ? [...loginSteps] : [card], outputs, ok: true };
}

// ── token endpoint calls ──
function clientCredentialsStep(def, f, auth) {
  const params = compact({ grant_type: 'client_credentials', scope: f.scope, audience: f.audience, resource: f.resource, ...parseLines(f.extra) });
  return tokenPost(meta(def), str(f.tokenUrl), auth, def.auth, params);
}

function tokenExchangeStep(def, f, auth) {
  if (!str(f.subjectToken)) return fail(def, f.tokenUrl, 'subject_token is empty — run the previous step or paste a token.');
  const params = compact({
    grant_type: GRANT_TOKEN_EXCHANGE,
    subject_token: str(f.subjectToken),
    subject_token_type: f.subjectTokenType,
    requested_token_type: f.requestedTokenType,
    audience: f.audience,
    scope: f.scope,
    resource: f.resource,
    ...parseLines(f.extra),
  });
  return tokenPost(meta(def), str(f.tokenUrl), auth, def.auth, params).then((r) => {
    if (!r.ok && r.outputs.interaction_uri) {
      r.message = 'Consent required (interaction_required). Open the interaction_uri output, authorize, then run this step again.';
    }
    return r;
  });
}

function jwtBearerStep(def, f, auth) {
  if (!str(f.assertion)) return fail(def, f.tokenUrl, 'assertion (id-JAG) is empty — run the previous step or paste one.');
  const params = compact({
    grant_type: GRANT_JWT_BEARER,
    assertion: str(f.assertion),
    scope: f.scope,
    requested_token_type: f.requestedTokenType,
    ...parseLines(f.extra),
  });
  return tokenPost(meta(def), str(f.tokenUrl), auth, def.auth, params, def.acceptJson ? { Accept: 'application/json' } : {});
}

/** Atlassian OAuth client_credentials with a JSON body (NHI · Secrets Atlassian, T3). */
async function atlassianClientCredentialsStep(def, f) {
  const url = str(f.tokenUrl);
  if (!str(f.clientId) || !str(f.clientSecret)) return fail(def, url, 'client_id and client_secret are required (bound from the vaulted secret).');
  const reqBody = compact({ grant_type: 'client_credentials', client_id: str(f.clientId), client_secret: str(f.clientSecret), audience: f.audience, scope: f.scope });
  const shown = { ...reqBody, client_secret: '••••••••' };
  const { status, body } = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(reqBody),
  });
  const ok = status >= 200 && status < 300 && !!body?.access_token;
  const step = {
    ...meta(def),
    ok,
    request: { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(shown, null, 2) },
    response: { status, headers: {}, body: ok ? { ...body, access_token: mask(body.access_token) } : body },
    token: null,
    code: `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(shown)}'`,
  };
  return { steps: [step], outputs: ok ? { access_token: body.access_token } : {}, ok };
}

// ── final hop: MCP ──
function authHeaderFor(f) {
  if (f.authScheme === 'basic') {
    const user = str(f.username);
    const pass = String(f.password ?? '');
    return {
      real: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
      shown: `Basic ${Buffer.from(`${user}:${'•'.repeat(Math.max(4, pass.length))}`).toString('base64')}`,
    };
  }
  if (f.authScheme === 'none') return null;
  const t = str(f.token);
  return { real: `Bearer ${t}`, shown: `Bearer ${mask(t)}` };
}

async function inProcessMcp(def, f, args) {
  const tool = str(f.tool);
  if (!tool) return fail(def, 'mcp://inventory/tools/call', 'Pick a tool for the in-process MCP.');
  const opts = { id: def.id, from: def.from, to: def.to };

  if (f.authScheme === 'basic') {
    const creds = { username: str(f.username), password: String(f.password ?? '') };
    const valid =
      f.validate === 'no' ||
      (config.mcpBasic.username && creds.username === config.mcpBasic.username && creds.password === config.mcpBasic.password);
    let result = null;
    if (valid) {
      try {
        result = await callMcpTool(tool, args);
      } catch (err) {
        return fail(def, 'mcp://inventory/tools/call', err.message);
      }
    }
    const step = buildBasicMcpStep(tool, creds, result, !!valid);
    step.id = def.id;
    return { steps: [step], outputs: valid ? { result: JSON.stringify(result) } : {}, ok: !!valid };
  }

  const token = str(f.token);
  if (!token) return fail(def, 'mcp://inventory/tools/call', 'Access token is empty — run the previous step or paste one.');
  const requiredScopes = str(f.requiredScopes).split(/[\s,]+/).filter(Boolean);
  const validation =
    f.validate === 'no'
      ? { ok: true, verified: false, skipped: true, requiredScopes: [], scopes: [], note: 'Validation skipped in the Tester' }
      : await validateAccessToken(token, requiredScopes, { issuer: str(f.issuer) || undefined, jwksUri: str(f.jwksUri) || undefined });
  if (!validation.ok) return { steps: [buildMcpStep(tool, token, null, validation, opts)], outputs: {}, ok: false };
  let result;
  try {
    result = await callMcpTool(tool, args);
  } catch (err) {
    return fail(def, 'mcp://inventory/tools/call', err.message);
  }
  return { steps: [buildMcpStep(tool, token, result, validation, opts)], outputs: { result: JSON.stringify(result) }, ok: true };
}

/** Remote MCP server over Streamable HTTP: initialize → tools/call (or tools/list). */
async function remoteMcp(def, f, args) {
  const url = str(f.url);
  if (!url) return fail(def, '', 'Enter the remote MCP server URL.');
  const auth = authHeaderFor(f);
  const steps = [];
  let sessionId = null;
  let rpcId = 0;
  let n = 1;

  const headers = (shown) => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    ...(auth ? { Authorization: shown ? auth.shown : auth.real } : {}),
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  });
  const post = async (payload) => {
    try {
      const res = await fetch(url, { method: 'POST', headers: headers(false), body: JSON.stringify(payload) });
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      const text = await res.text();
      return { status: res.status, body: text ? parseRpc(text, payload.id) : '' };
    } catch (err) {
      return { status: 0, body: { error: 'network_error', error_description: err.message } };
    }
  };
  const record = (title, payload, status, body, ok) => {
    const shown = headers(true);
    steps.push({
      id: `${def.id}.${n++}`,
      title,
      badge: 'MCP',
      from: def.from,
      to: def.to,
      ok,
      request: { method: 'POST', url, headers: shown, body: JSON.stringify(payload, null, 2) },
      response: { status, headers: {}, body },
      token: auth && f.authScheme !== 'basic' ? decodeJwt(str(f.token)) : null,
      code: `curl -X POST '${url}' \\\n${Object.entries(shown).map(([k, v]) => `  -H '${k}: ${v}' \\\n`).join('')}  -d '${JSON.stringify(payload)}'`,
    });
  };

  const init = {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'o4aa-tester', version: '1.0.0' } },
  };
  const r1 = await post(init);
  const initOk = r1.status >= 200 && r1.status < 300 && !!r1.body?.result;
  record('MCP · initialize', init, r1.status, r1.body, initOk);
  if (!initOk) return { steps, outputs: {}, ok: false };
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tool = str(f.tool);
  if (!tool) {
    const list = { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} };
    const r = await post(list);
    const ok = r.status >= 200 && r.status < 300 && !!r.body?.result;
    record('MCP · tools/list', list, r.status, r.body, ok);
    return { steps, outputs: ok ? { tools: (r.body.result.tools || []).map((t) => t.name).join(', ') } : {}, ok };
  }
  const call = { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args || {} } };
  const r = await post(call);
  const result = r.body?.result;
  const ok = r.status >= 200 && r.status < 300 && !!result && !result.isError;
  const data = result ? toolPayload(result) : null;
  record(`MCP Tool Call · ${tool}`, call, r.status, result ? { ...r.body, result: { ...result, parsed: data } } : r.body, ok);
  return { steps, outputs: ok ? { result: typeof data === 'string' ? data : JSON.stringify(data) } : {}, ok };
}

function mcpStep(def, f) {
  const parsed = parseJson(f.args, 'Tool arguments');
  if (parsed.error) return fail(def, f.url, parsed.error);
  return f.target === 'remote' ? remoteMcp(def, f, parsed.value || {}) : inProcessMcp(def, f, parsed.value || {});
}

// ── final hop: any HTTP API (GitHub, Jira REST, …) ──
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function httpStep(def, f) {
  let url = str(f.url);
  const method = (f.method || 'GET').toUpperCase();
  if (!url) return fail(def, '', 'Enter the API URL.', method);
  const auth = authHeaderFor(f);
  const headers = { Accept: 'application/json', ...parseLines(f.headers, ':'), ...(auth ? { Authorization: auth.real } : {}) };

  // Jira-style URLs carry the Atlassian site id; resolve a site name to its UUID.
  if (url.includes('{cloudId}')) {
    let cloudId = str(f.cloudId);
    if (!UUID.test(cloudId)) {
      const origin = new URL(url.replace('{cloudId}', 'x')).origin;
      cloudId = await resolveCloudId(origin, cloudId, headers);
    }
    if (!cloudId) return fail(def, url, 'Could not resolve {cloudId} — set the Cloud ID field to the site UUID (or a site the token can reach).', method);
    url = url.split('{cloudId}').join(cloudId);
  }

  const parsed = method === 'GET' || method === 'HEAD' ? { value: undefined } : parseJson(f.body, 'Body');
  if (parsed.error) return fail(def, url, parsed.error, method);
  const init = { method, headers: { ...headers } };
  if (parsed.value !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(parsed.value);
  }
  const { status, body } = await doFetch(url, init);
  const ok = status >= 200 && status < 300;
  const shownHeaders = { ...init.headers, ...(auth ? { Authorization: auth.shown } : {}) };
  const step = {
    ...meta(def),
    ok,
    request: { method, url, headers: shownHeaders, body: init.body ? JSON.stringify(parsed.value, null, 2) : '' },
    response: { status, headers: {}, body },
    token: auth && f.authScheme !== 'basic' ? decodeJwt(str(f.token)) : null,
    code:
      `curl -X ${method} '${url}' \\\n` +
      Object.entries(shownHeaders).map(([k, v]) => `  -H '${k}: ${v}'`).join(' \\\n') +
      (init.body ? ` \\\n  -d '${init.body}'` : ''),
  };
  return { steps: [step], outputs: ok ? { result: typeof body === 'string' ? body : JSON.stringify(body) } : {}, ok };
}

// ── final hop: Atlassian Rovo MCP (Jira read / create) ──
async function atlassianMcpStep(def, f) {
  const token = str(f.token);
  if (!token) return fail(def, f.mcpUrl, 'Access token is empty — run the previous step or paste one.');
  const steps = [];
  const opts = {
    mcpUrl: str(f.mcpUrl),
    cloudId: str(f.cloudId),
    fallbackCloudId: str(f.fallbackCloudId) || undefined,
    projectKey: str(f.projectKey) || undefined,
    issueType: str(f.issueType) || 'Task',
    summary: str(f.summary),
    description: str(f.description),
    maxResults: Number(f.maxResults) || 10,
    firstStep: Number(String(def.id).replace(/\D/g, '')) || 3,
    envPrefix: def.envPrefix || 'ATLASSIAN',
    mcpUrlVar: 'the MCP URL field',
  };
  const r = f.action === 'create' ? await createJiraIssue(token, steps, opts) : await readJiraIssues(token, steps, opts);
  const outputs = {};
  if (r.ok && r.issue?.key) outputs.issue_key = r.issue.key;
  if (r.ok && r.issue?.browseUrl) outputs.issue_url = r.issue.browseUrl;
  if (r.ok && r.issues) outputs.issue_keys = r.issues.map((i) => i.key).filter(Boolean).join(', ');
  return { steps, outputs, ok: !!r.ok, message: r.ok ? undefined : r.error };
}

/** Run one step. `session` is only read by the subject step (current-session tokens). */
export async function runStep(def, values = {}, session) {
  const f = values.fields || {};
  const auth = values.auth || {};
  switch (def.kind) {
    case 'subject':
      return subjectStep(def, f, session);
    case 'client_credentials':
      return clientCredentialsStep(def, f, auth);
    case 'token_exchange':
      return tokenExchangeStep(def, f, auth);
    case 'jwt_bearer':
      return jwtBearerStep(def, f, auth);
    case 'atlassian_cc':
      return atlassianClientCredentialsStep(def, f);
    case 'mcp':
      return mcpStep(def, f);
    case 'http':
      return httpStep(def, f);
    case 'atlassian_mcp':
      return atlassianMcpStep(def, f);
    default:
      return fail(def, '', `Unknown step kind '${def.kind}'.`);
  }
}
