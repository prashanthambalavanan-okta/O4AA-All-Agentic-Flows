import { config } from '../config.js';
import { doFetch, mask } from './atlassian.js';

// HI · STS Broker (Atlassian): the Atlassian token Okta brokered at T2 carries Rovo
// "agent-interface" scopes (read:jira:agent-interface, …), which are honoured by
// Atlassian's remote MCP server — not the Jira REST API. So from T3 on the agent is an
// MCP client: initialize a session, then call Jira tools. The JSON-RPC is hand-built
// (rather than via the MCP SDK) so every request/response shows up as a step card.

const PROTOCOL_VERSION = '2025-06-18';

// Parse a Streamable HTTP response: plain JSON, or an SSE stream of `data:` frames.
// Returns the JSON-RPC message answering `id` (or the first message if none matches).
function parseRpc(text, id) {
  try {
    return JSON.parse(text);
  } catch {
    /* not plain JSON — try SSE */
  }
  const msgs = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      msgs.push(JSON.parse(data));
    } catch {
      /* skip keep-alives / partial frames */
    }
  }
  return msgs.find((m) => m.id === id) || msgs[0] || text;
}

// Tool results come back as content[] text blocks; Atlassian's are usually JSON text.
function toolPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A minimal MCP client for one flow run. Every call records a step: T3, T4, … in order.
 */
export class AtlassianMcpSession {
  constructor(accessToken, steps, firstStep = 3, url = config.stsAtlassian.mcpUrl) {
    this.accessToken = accessToken;
    this.steps = steps;
    this.n = firstStep;
    this.rpcId = 0;
    this.sessionId = null;
    this.url = url;
  }

  headers(shown = false) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${shown ? mask(this.accessToken) : this.accessToken}`,
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async post(payload) {
    try {
      const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload) });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const text = await res.text();
      return { status: res.status, body: text ? parseRpc(text, payload.id) : '' };
    } catch (err) {
      return { status: 0, body: { error: 'network_error', error_description: err.message } };
    }
  }

  record(title, payload, status, body, ok) {
    const shownHeaders = this.headers(true);
    const step = {
      id: `T${this.n++}`,
      title,
      badge: 'MCP',
      from: 'Agent',
      to: 'Atlassian MCP',
      ok,
      request: { method: 'POST', url: this.url, headers: shownHeaders, body: JSON.stringify(payload, null, 2) },
      response: { status, headers: {}, body },
      token: null,
      code:
        `curl -X POST '${this.url}' \\\n` +
        Object.entries(shownHeaders).map(([k, v]) => `  -H '${k}: ${v}' \\\n`).join('') +
        `  -d '${JSON.stringify(payload)}'`,
    };
    this.steps.push(step);
    return step;
  }

  /** A plain REST GET with the brokered token, recorded as the next step. */
  async getJson(title, url, to = 'Atlassian') {
    const headers = { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' };
    const { status, body } = await doFetch(url, { headers });
    const ok = status >= 200 && status < 300;
    this.steps.push({
      id: `T${this.n++}`,
      title,
      badge: 'Atlassian',
      from: 'Agent',
      to,
      ok,
      request: { method: 'GET', url, headers: { ...headers, Authorization: `Bearer ${mask(this.accessToken)}` }, body: '' },
      response: { status, headers: {}, body },
      token: null,
      code: `curl '${url}' \\\n  -H 'Authorization: Bearer ${mask(this.accessToken)}' \\\n  -H 'Accept: application/json'`,
    });
    return { ok, body };
  }

  /** initialize + notifications/initialized. Returns true when the session is up. */
  async initialize() {
    const payload = {
      jsonrpc: '2.0',
      id: ++this.rpcId,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'o4aa-agent', version: '1.0.0' } },
    };
    const { status, body } = await this.post(payload);
    const ok = status >= 200 && status < 300 && !!body?.result;
    this.record('Atlassian MCP · initialize', payload, status, body, ok);
    if (ok) await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return ok;
  }

  /** tools/list → the named tool's inputSchema (null if unavailable). Recorded as a step. */
  async toolSchema(name) {
    const payload = { jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/list', params: {} };
    const { status, body } = await this.post(payload);
    const tools = body?.result?.tools || [];
    const tool = tools.find((t) => t.name === name);
    const ok = status >= 200 && status < 300 && !!tool;
    // Only the relevant tool's definition is shown — the full list is long.
    this.record(`Atlassian MCP · tools/list (${name} schema)`, payload, status, tool ? { tool } : body, ok);
    return tool?.inputSchema || null;
  }

  /** tools/call. Returns { ok, data } where data is the parsed tool output. */
  async callTool(name, args) {
    const payload = { jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/call', params: { name, arguments: args } };
    const { status, body } = await this.post(payload);
    const result = body?.result;
    const ok = status >= 200 && status < 300 && !!result && !result.isError;
    const data = result ? toolPayload(result) : null;
    this.record(`MCP Tool Call · ${name}`, payload, status, result ? { ...body, result: { ...result, parsed: data } } : body, ok);
    return { ok, data, error: ok ? null : rpcError(status, body, data) };
  }
}

function rpcError(status, body, data) {
  if (body?.error?.message) return body.error.message;
  if (typeof data === 'string') return data;
  if (status === 401 || status === 403) return `HTTP ${status} — the access token was rejected by the Atlassian MCP server.`;
  return `HTTP ${status}`;
}

// Sites the token can reach: [{ id, url, name }].
function asSites(data) {
  const list = Array.isArray(data) ? data : data?.resources || data?.sites || [];
  return list.filter((s) => s && (s.id || s.url));
}

// Pick the site: <prefix>_CLOUD_ID (UUID, site URL, or bare site name), else the
// first site the token can reach. The Atlassian MCP tools accept a UUID or a site URL.
// Discovery uses the standard accessible-resources endpoint (works for any Atlassian
// OAuth token, no extra scope) rather than an MCP tool that may need other scopes.
async function resolveSite(mcp, o) {
  const configured = (o.cloudId || '').trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(configured);
  if (configured && isUuid) return { cloudId: configured, siteUrl: null };
  if (configured) {
    const host = configured.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const siteUrl = `https://${host.includes('.') ? host : `${host}.atlassian.net`}`;
    return { cloudId: siteUrl, siteUrl };
  }
  const r = await mcp.getJson('Accessible Atlassian Sites', 'https://api.atlassian.com/oauth/token/accessible-resources');
  const sites = r.ok ? asSites(r.body) : [];
  // Prefer a site the token holds Jira scopes for.
  const site = sites.find((x) => (x.scopes || []).some((sc) => sc.includes('jira'))) || sites[0];
  // Nothing discoverable — fall back to a flow-supplied guess (e.g. the id-JAG's aud_tenant).
  if (!site && o.fallbackCloudId) return { cloudId: o.fallbackCloudId, siteUrl: null };
  if (!site) {
    return { error: `The access token cannot reach any Atlassian site — set ${o.envPrefix}_CLOUD_ID.` };
  }
  return { cloudId: site.id || site.url, siteUrl: site.url || null };
}

// A bounded JQL across all projects (the JQL search endpoint rejects unbounded queries).
const ALL_RECENT_JQL = 'created >= -3650d ORDER BY created DESC';
// Find the Jira issues anywhere in a tool result, whatever its envelope (plain array,
// { issues }, { data: { issues: { nodes } } }, JSON nested inside text, …): the first
// array whose items carry an issue key like "SCRUM-27".
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
export function issueList(data, depth = 0) {
  if (depth > 6 || data == null) return [];
  if (typeof data === 'string') {
    try {
      return issueList(JSON.parse(data), depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(data)) {
    if (data.some((x) => x && typeof x === 'object' && ISSUE_KEY.test(x.key || x.issueKey || ''))) return data;
    for (const x of data) {
      const found = issueList(x, depth + 1);
      if (found.length) return found;
    }
    return [];
  }
  if (typeof data === 'object') {
    for (const v of Object.values(data)) {
      const found = issueList(v, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

// Read a field from an issue whether it is nested under `fields` or flattened.
const field = (i, name) => i?.fields?.[name] ?? i?.[name];
const label = (v) => (v && typeof v === 'object' ? v.displayName ?? v.name ?? v.value ?? '' : v ?? '');

// For create with no <prefix>_PROJECT_KEY: the project of the most recent ticket
// (search scope only); getVisibleJiraProjects is only a last resort.
async function resolveProject(mcp, cloudId, o) {
  if (o.projectKey) return { projectKey: o.projectKey };

  const s = await mcp.callTool('searchJiraIssuesUsingJql', { cloudId, jql: ALL_RECENT_JQL, fields: ['project'], maxResults: 1 });
  const first = s.ok ? issueList(s.data)[0] : null;
  let projectKey = first?.fields?.project?.key || first?.key?.split('-')[0];
  if (projectKey) return { projectKey };

  const r = await mcp.callTool('getVisibleJiraProjects', { cloudId, action: 'browse', maxResults: 1 });
  const list = Array.isArray(r.data) ? r.data : r.data?.values || r.data?.projects || [];
  projectKey = list[0]?.key;
  if (!projectKey) {
    return { error: s.ok || r.ok ? `No Jira project is visible to the access token — set ${o.envPrefix}_PROJECT_KEY.` : `${r.error || s.error} — set ${o.envPrefix}_PROJECT_KEY` };
  }
  return { projectKey };
}

// Per-flow Jira/MCP settings. Defaults to the STS Broker (Atlassian) flow's config, so
// that flow passes nothing; other flows (HI - Cross-App Access (Atlassian)) override
// mcpUrl / cloudId / projectKey / firstStep and the env-var prefix used in messages.
function jiraOptions(opts = {}) {
  return {
    ...config.stsAtlassian,
    firstStep: 3,
    envPrefix: 'ATLASSIAN_STS',
    mcpUrlVar: 'ATLASSIAN_MCP_URL',
    ...opts,
  };
}

async function openSession(accessToken, steps, o) {
  const mcp = new AtlassianMcpSession(accessToken, steps, o.firstStep, o.mcpUrl);
  if (!(await mcp.initialize())) {
    return { error: `Could not open an Atlassian MCP session — see step T${o.firstStep} (check ${o.mcpUrlVar} and the access token).` };
  }
  const site = await resolveSite(mcp, o);
  if (site.error) return { error: site.error };
  return { mcp, ...site };
}

/** Read the most recent Jira tickets (one project, or all projects) via the MCP JQL search tool. */
export async function readJiraIssues(accessToken, steps, opts) {
  const o = jiraOptions(opts);
  const s = await openSession(accessToken, steps, o);
  if (s.error) return { ok: false, error: s.error, issues: [] };

  const projectKey = o.projectKey;
  const r = await s.mcp.callTool('searchJiraIssuesUsingJql', {
    cloudId: s.cloudId,
    jql: projectKey ? `project = "${projectKey}" ORDER BY created DESC` : ALL_RECENT_JQL,
    fields: ['summary', 'status', 'assignee'],
    maxResults: o.maxResults,
  });
  if (!r.ok) return { ok: false, error: `Jira search failed: ${r.error}`, issues: [] };
  return { ok: true, projectKey: projectKey || 'all projects', issues: issueList(r.data), raw: r.data };
}

// Build createJiraIssue arguments from the tool's declared inputSchema, so v1/v2 naming
// differences (issueTypeName vs issueType, projectKey vs project, …) don't break the call.
// Falls back to the v2 names when the schema isn't available.
function createArgs(schema, v) {
  const props = schema?.properties || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(props, k);
  const pick = (...names) => names.find(has);
  // A property typed as an object takes { name } / { key } rather than a bare string.
  const shape = (k, obj) => (props[k]?.type === 'object' ? obj : Object.values(obj)[0]);

  if (!schema) {
    return { cloudId: v.cloudId, projectKey: v.projectKey, issueType: v.issueType, summary: v.summary, description: v.description };
  }
  const args = {};
  const cloud = pick('cloudId', 'cloudID', 'siteId', 'site');
  if (cloud) args[cloud] = v.cloudId;
  const project = pick('projectKey', 'project', 'projectIdOrKey', 'projectId');
  if (project) args[project] = shape(project, { key: v.projectKey });
  const type = pick('issueType', 'issueTypeName', 'issuetype', 'type');
  if (type) args[type] = shape(type, { name: v.issueType });
  const summary = pick('summary', 'title');
  if (summary) args[summary] = v.summary;
  const desc = pick('description', 'body');
  if (desc) args[desc] = v.description;
  return args;
}

/** Create a Jira ticket via the MCP createJiraIssue tool — a write that exercises the scopes. */
export async function createJiraIssue(accessToken, steps, opts) {
  const o = jiraOptions(opts);
  const s = await openSession(accessToken, steps, o);
  if (s.error) return { ok: false, error: s.error, issue: null };
  const project = await resolveProject(s.mcp, s.cloudId, o);
  if (project.error) return { ok: false, error: project.error, issue: null };
  s.projectKey = project.projectKey;

  const { issueType, summary, description } = o;
  const schema = await s.mcp.toolSchema('createJiraIssue');
  const r = await s.mcp.callTool('createJiraIssue', createArgs(schema, { cloudId: s.cloudId, projectKey: s.projectKey, issueType, summary, description }));
  if (!r.ok) return { ok: false, error: `Jira create failed: ${r.error}`, issue: null };

  // v2 wraps the created issue differently from v1 — dig the key / link out of whatever
  // came back (object at any depth, JSON text, or plain prose like "Created SCRUM-28").
  const key = findIssueKey(r.data);
  const browseUrl =
    findBrowseUrl(r.data, key) ||
    (key && s.siteUrl ? `${s.siteUrl}/browse/${key}` : null) ||
    (key ? await siteBrowseUrl(s.mcp, s.cloudId, key) : null);
  return {
    ok: true,
    projectKey: s.projectKey,
    issue: { key, browseUrl, summary, issueType, description, projectKey: s.projectKey, raw: r.data },
  };
}

// Every string in a value (including JSON nested in strings), up to a modest depth.
function strings(v, depth = 0, out = []) {
  if (depth > 8 || v == null) return out;
  if (typeof v === 'string') {
    out.push(v);
    try {
      const j = JSON.parse(v);
      if (j && typeof j === 'object') strings(j, depth + 1, out);
    } catch {
      /* plain text */
    }
  } else if (Array.isArray(v)) v.forEach((x) => strings(x, depth + 1, out));
  else if (typeof v === 'object') Object.values(v).forEach((x) => strings(x, depth + 1, out));
  return out;
}

export function findIssueKey(data) {
  const all = strings(data);
  return all.find((x) => ISSUE_KEY.test(x)) || all.map((x) => x.match(/\b[A-Z][A-Z0-9_]+-\d+\b/)?.[0]).find(Boolean) || null;
}

export function findBrowseUrl(data, key) {
  const urls = strings(data).flatMap((x) => x.match(/https?:\/\/[^\s"')]+/g) || []);
  return urls.find((u) => /\/browse\//.test(u)) || (key ? urls.find((u) => u.includes(key) && !/\/rest\//.test(u)) : null) || null;
}

// cloudId given as a UUID → look the site URL up once to build the browse link.
async function siteBrowseUrl(mcp, cloudId, key) {
  const { ok, body } = await mcp.getJson('Accessible Atlassian Sites', 'https://api.atlassian.com/oauth/token/accessible-resources');
  const site = ok ? asSites(body).find((x) => x.id === cloudId) || asSites(body)[0] : null;
  return site?.url ? `${site.url}/browse/${key}` : null;
}

export function summarizeJiraIssues(issues, projectKey, raw) {
  if (!issues.length) {
    // Unrecognised tool output shape — show the text rather than claiming "none".
    if (typeof raw === 'string' && raw.trim()) return raw.slice(0, 2000);
    return `No Jira tickets found in ${projectKey}.`;
  }
  const lines = issues.map((i) => {
    const key = i.key || i.issueKey;
    const status = label(field(i, 'status')) || 'unknown';
    const assignee = label(field(i, 'assignee'));
    return `• ${key} — ${label(field(i, 'summary'))} [${status}]${assignee ? ` · ${assignee}` : ''}`;
  });
  return `Found ${issues.length} Jira ticket(s) in ${projectKey}:\n\n${lines.join('\n')}`;
}
