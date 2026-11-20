// Tester — every flow as an ordered list of editable steps, prefilled from the same
// .env / .env.a2a / .env.auth-patterns config the chat path uses. Step ids match the
// Sequence tab (T1, T2, …) so the two views line up.
//
// A step's fields are rendered by the Tester tab. `bind` lists the outputs of earlier
// steps that fill a field automatically ("T2.access_token"); the first one available
// wins. `showIf` hides a field unless other fields have the given values.
import { config } from '../config.js';
import { getAgent, signingKid } from '../xaa/authPatternFlow.js';
import { getAtlassianCredentials } from '../xaa/atlassianDcr.js';
import { listToolDefs } from '../mcp/inventoryServer.js';
import { TOKEN_TYPES } from './steps.js';

// ── field builders ──
const text = (key, label, value, extra = {}) => ({ key, label, type: 'text', default: value ?? '', ...extra });
const area = (key, label, value, extra = {}) => ({ key, label, type: 'textarea', default: value ?? '', ...extra });
const select = (key, label, options, value, extra = {}) => ({ key, label, type: 'select', options, default: value ?? options[0]?.value ?? '', ...extra });
const combo = (key, label, options, value, extra = {}) => ({ key, label, type: 'combo', options, default: value ?? '', ...extra });

const TOKEN_TYPE_OPTIONS = Object.entries(TOKEN_TYPES).map(([k, v]) => ({ value: v, label: k }));

const INVENTORY_TOOLS = ['get_inventory_details', 'get_last_5_shipments'];
const FINANCE_TOOLS = ['get_customer_arr', 'get_customer_payment_details'];
const toolOptions = () => listToolDefs().map((t) => ({ value: t.name, label: t.name }));

// ── client-auth defaults ──
function authFrom({ method = 'private_key_jwt', clientId, kid, privateKeyFile, clientSecret, sendClientId = false }) {
  return {
    default: {
      method,
      clientId: clientId || '',
      kid: kid || '',
      keySource: 'file',
      privateKeyFile: privateKeyFile || config.agent.privateKeyFile || '',
      privateKeyPem: '',
      clientSecret: '',
      assertionAudience: '',
      sendClientId,
    },
    _secret: clientSecret || undefined,
  };
}
const agentAuth = (overrides = {}) =>
  authFrom({ clientId: config.agent.clientId, kid: config.agent.kid, privateKeyFile: config.agent.privateKeyFile, ...overrides });
/** An OIDC login app config (config.okta / webapp / a2a.okta / auth-pattern agent). */
const loginAppAuth = (cfg, extra = {}) =>
  authFrom({
    method: cfg.tokenAuthMethod,
    clientId: cfg.clientId,
    kid: cfg.kid,
    privateKeyFile: cfg.privateKeyFile,
    clientSecret: cfg.clientSecret,
    ...extra,
  });

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : null);

// ── step builders ──

/**
 * T1 of every user flow: where the subject token comes from — the token this flow's
 * own login stored in the session, a pasted token, or a fresh authorization-code login
 * run by the Tester with any client id / auth method.
 */
function subject({ id = 'T1', sessionLabel, tokenType, fromSession, login }) {
  const modes = [
    { value: 'session', label: `Current session (${sessionLabel})` },
    { value: 'paste', label: 'Paste a token' },
  ];
  if (login) modes.push({ value: 'login', label: 'Fresh login (authorization code + PKCE)' });
  const onLogin = { mode: 'login' };
  const fields = [
    select('mode', 'Source', modes, 'session'),
    area('token', 'Subject token', '', { showIf: { mode: 'paste' }, rows: 4, placeholder: tokenType === 'saml2' ? 'base64 SAML assertion' : 'eyJ…' }),
    select('tokenType', 'Token type', ['id_token', 'access_token', 'refresh_token', 'saml2'].map((v) => ({ value: v, label: v })), tokenType, {
      showIf: { mode: 'paste' },
    }),
  ];
  if (login) {
    fields.push(
      text('issuer', 'Issuer (authorization server)', login.issuer, { showIf: onLogin, help: 'Discovered via /.well-known/openid-configuration.' }),
      text('scopes', 'Scopes', login.scopes, { showIf: onLogin }),
      text('resource', 'resource (optional, RFC 8707)', login.resource, { showIf: onLogin }),
      select('prompt', 'prompt', [{ value: '', label: '(none)' }, { value: 'login', label: 'login' }, { value: 'consent', label: 'consent' }], '', { showIf: onLogin }),
      select('useToken', 'Use as subject token', [{ value: 'id_token', label: 'id_token' }, { value: 'access_token', label: 'access_token' }], login.useToken, { showIf: onLogin }),
      combo('redirectUri', 'Redirect URI', config.tester.redirectUris.map((u) => ({ value: u, label: u })), config.tester.redirectUri, {
        showIf: onLogin,
        help: 'Use the one for the host you are on (the IdP sends the code back there). It must be registered on the app you log in with.',
      })
    );
  }
  return {
    id,
    kind: 'subject',
    title: 'Subject Token (user login)',
    badge: 'Subject',
    from: 'User',
    to: 'Agent',
    tokenType,
    sessionLabel,
    fromSession,
    fields,
    auth: login ? login.auth : null,
    authShowIf: onLogin,
    authLabel: 'Login client authentication (at /token)',
    outputs: ['token', 'subject_token_type', 'id_token', 'access_token'],
  };
}

function clientCredentials({ id = 'T1', title = 'Client Credentials', from = 'Service App', to = 'Okta', tokenUrl, auth, scope, audience, resource }) {
  return {
    id,
    kind: 'client_credentials',
    title,
    badge: 'Access Token',
    from,
    to,
    auth,
    authLabel: 'Service app client authentication',
    fields: [
      text('tokenUrl', 'Token URL', tokenUrl),
      text('scope', 'scope', scope),
      text('audience', 'audience', audience),
      text('resource', 'resource', resource),
      area('extra', 'Extra params (key=value per line)', '', { rows: 2 }),
    ],
    outputs: ['access_token'],
  };
}

function tokenExchange({
  id,
  title = 'Token Exchange',
  badge = 'ID-JAG',
  from = 'Agent',
  to = 'IdP',
  tokenUrl,
  auth,
  subjectBind,
  subjectTokenType,
  subjectTypeBind,
  requestedTokenType = TOKEN_TYPES.id_jag,
  audience,
  scope,
  resource,
  hideAudience = false,
}) {
  const fields = [
    text('tokenUrl', 'Token URL', tokenUrl),
    area('subjectToken', 'subject_token', '', { bind: subjectBind, rows: 3 }),
    combo('subjectTokenType', 'subject_token_type', TOKEN_TYPE_OPTIONS, subjectTokenType, { bind: subjectTypeBind }),
    combo('requestedTokenType', 'requested_token_type', TOKEN_TYPE_OPTIONS, requestedTokenType),
  ];
  if (!hideAudience) fields.push(text('audience', 'audience', audience));
  fields.push(
    text('scope', 'scope', scope),
    text('resource', 'resource', resource),
    area('extra', 'Extra params (key=value per line)', '', { rows: 2 })
  );
  return { id, kind: 'token_exchange', title, badge, from, to, auth, authLabel: 'Agent client authentication', fields, outputs: ['access_token'] };
}

function jwtBearer({ id, title = 'Access Token Request (jwt-bearer)', from = 'Agent', to = 'Resource Auth Server', tokenUrl, auth, bind, requestedTokenType = '', acceptJson = false, authLabel }) {
  return {
    id,
    kind: 'jwt_bearer',
    title,
    badge: 'Access Token',
    from,
    to,
    auth,
    acceptJson,
    authLabel: authLabel || 'Agent client authentication',
    fields: [
      text('tokenUrl', 'Token URL', tokenUrl),
      area('assertion', 'assertion (id-JAG)', '', { bind, rows: 3 }),
      text('scope', 'scope (optional)', ''),
      combo('requestedTokenType', 'requested_token_type (optional)', TOKEN_TYPE_OPTIONS, requestedTokenType),
      area('extra', 'Extra params (key=value per line)', '', { rows: 2 }),
    ],
    outputs: ['access_token'],
  };
}

const authSchemeField = (value) =>
  select('authScheme', 'Authorization', [
    { value: 'bearer', label: 'Bearer token' },
    { value: 'basic', label: 'HTTP Basic (username / password)' },
    { value: 'none', label: 'None' },
  ], value);

/** Final hop to an MCP server — the built-in inventory/finance MCP, or any remote MCP URL. */
function mcp({ id, from = 'Agent', to = 'Inventory MCP', tokenBind, authScheme = 'bearer', userBind, passBind, tool, issuer, jwksUri, scopes }) {
  return {
    id,
    kind: 'mcp',
    title: 'MCP Tool Call',
    badge: 'MCP',
    from,
    to,
    fields: [
      select('target', 'MCP server', [
        { value: 'inprocess', label: 'Built-in demo MCP (in-process)' },
        { value: 'remote', label: 'Remote MCP server URL (Streamable HTTP)' },
      ], 'inprocess'),
      text('url', 'MCP URL', '', { showIf: { target: 'remote' }, placeholder: 'https://mcp.example.com/mcp' }),
      authSchemeField(authScheme),
      area('token', 'Access token', '', { bind: tokenBind, rows: 3, showIf: { authScheme: 'bearer' } }),
      text('username', 'Username', '', { bind: userBind, showIf: { authScheme: 'basic' } }),
      text('password', 'Password', '', { bind: passBind, showIf: { authScheme: 'basic' }, secret: true }),
      combo('tool', 'Tool name', toolOptions(), tool, { help: 'Remote MCP: leave blank to run tools/list.' }),
      area('args', 'Tool arguments (JSON)', '{}', { rows: 2 }),
      select('validate', 'Validate credentials first (built-in MCP)', [
        { value: 'yes', label: 'Yes — verify like a resource server' },
        { value: 'no', label: 'No — call the tool directly' },
      ], 'yes', { showIf: { target: 'inprocess' } }),
      text('issuer', 'Expected issuer', issuer, { showIf: { target: 'inprocess', validate: 'yes', authScheme: 'bearer' } }),
      text('jwksUri', 'JWKS URI', jwksUri, { showIf: { target: 'inprocess', validate: 'yes', authScheme: 'bearer' } }),
      text('requiredScopes', 'Required scopes', scopes, { showIf: { target: 'inprocess', validate: 'yes', authScheme: 'bearer' } }),
    ],
    outputs: ['result'],
  };
}

/** Final hop to any HTTP API. `presets` fill method/url/body in one click. */
function http({ id, title, badge, to, tokenBind, presets, headers = '', cloudId }) {
  const first = presets[0].apply;
  const fields = [
    select('preset', 'Preset', presets.map((p) => ({ value: p.value, label: p.label, apply: p.apply })), presets[0].value),
    select('method', 'Method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })), first.method),
    text('url', 'URL', first.url, { help: '{cloudId} is resolved from the Cloud ID field (site UUID, site name, or blank = first site).' }),
    authSchemeField('bearer'),
    area('token', 'Access token', '', { bind: tokenBind, rows: 3, showIf: { authScheme: 'bearer' } }),
    text('username', 'Username', '', { showIf: { authScheme: 'basic' } }),
    text('password', 'Password', '', { showIf: { authScheme: 'basic' }, secret: true }),
    area('headers', 'Extra headers (Header: value per line)', headers, { rows: 2 }),
    area('body', 'JSON body (non-GET)', first.body ?? '', { rows: 5 }),
  ];
  if (cloudId !== undefined) fields.push(text('cloudId', 'Cloud ID', cloudId));
  return { id, kind: 'http', title, badge, from: 'Agent', to, fields, outputs: ['result'] };
}

function atlassianMcp({ id, cfg, tokenBind, fallbackBind, envPrefix }) {
  return {
    id,
    kind: 'atlassian_mcp',
    title: 'Atlassian MCP · Jira',
    badge: 'MCP',
    from: 'Agent',
    to: 'Atlassian MCP',
    envPrefix,
    fields: [
      select('action', 'Action', [{ value: 'read', label: 'Read Jira tickets' }, { value: 'create', label: 'Create a Jira ticket' }], 'read'),
      text('mcpUrl', 'MCP URL', cfg.mcpUrl),
      area('token', 'Access token', '', { bind: tokenBind, rows: 3 }),
      text('cloudId', 'Cloud ID / site (blank = discover)', cfg.cloudId),
      ...(fallbackBind ? [text('fallbackCloudId', 'Fallback cloud ID', '', { bind: fallbackBind })] : []),
      text('projectKey', 'Project key (blank = all / first)', cfg.projectKey),
      text('maxResults', 'Max results', String(cfg.maxResults || 10), { showIf: { action: 'read' } }),
      text('issueType', 'Issue type', cfg.issueType, { showIf: { action: 'create' } }),
      text('summary', 'Summary', cfg.summary, { showIf: { action: 'create' } }),
      area('description', 'Description', cfg.description, { showIf: { action: 'create' }, rows: 2 }),
    ],
    outputs: ['issue_keys', 'issue_key', 'issue_url'],
  };
}

// ── subject-token contexts (where each flow's T1 token lives in the session) ──
const loginOf = (cfg, useToken, resource) => ({
  issuer: cfg.issuer,
  scopes: cfg.scopes,
  resource: resource || '',
  useToken,
  auth: loginAppAuth(cfg),
});

const SUBJECTS = {
  default: () =>
    subject({
      sessionLabel: 'agent login id_token',
      tokenType: 'id_token',
      fromSession: (s) => ({ token: s.idToken, loginSteps: asArray(s.loginStep), extra: { access_token: s.accessToken } }),
      login: loginOf(config.okta, 'id_token'),
    }),
  webapp: () =>
    subject({
      sessionLabel: 'web app access_token',
      tokenType: 'access_token',
      fromSession: (s) => ({ token: s.webappAccessToken, loginSteps: asArray(s.webappLoginStep) }),
      login: loginOf(config.webapp, 'access_token', config.webapp.resource),
    }),
  a2a: () =>
    subject({
      sessionLabel: 'A2A login access_token',
      tokenType: 'access_token',
      fromSession: (s) => ({ token: s.a2aAccessToken, loginSteps: asArray(s.a2aLoginStep) }),
      login: config.a2a.okta.issuer ? loginOf(config.a2a.okta, 'access_token', config.a2a.inventoryAgent.resource) : null,
    }),
  saml: () =>
    subject({
      sessionLabel: 'SAML assertion',
      tokenType: 'saml2',
      fromSession: (s) => ({ token: s.samlAssertion, loginSteps: asArray(s.samlLoginStep) }),
      login: null,
    }),
  authp: (pattern, agent, kid) =>
    subject({
      sessionLabel: `${agent.label} agent id_token`,
      tokenType: 'id_token',
      fromSession: (s) => ({ token: s.authp?.[pattern]?.idToken, loginSteps: asArray(s.authp?.[pattern]?.loginStep) }),
      login: {
        issuer: config.authPatterns.issuer,
        scopes: config.authPatterns.scopes,
        resource: '',
        useToken: 'id_token',
        auth: loginAppAuth({ ...agent, kid }, { sendClientId: true }),
      },
    }),
};

// ── shared chains ──
const resourceT3 = (id, bind, clientId = config.resource.clientId) =>
  jwtBearer({
    id,
    tokenUrl: config.resource.tokenUrl,
    bind,
    auth: authFrom({ clientId, kid: config.resource.kid, privateKeyFile: config.agent.privateKeyFile }),
  });

const inventoryMcp = (id, tokenBind) =>
  mcp({
    id,
    tokenBind,
    tool: INVENTORY_TOOLS[0],
    issuer: config.resource.issuer,
    jwksUri: config.resource.jwksUri,
    scopes: config.resource.scopes,
  });

/** user/service token → id-JAG (T2) → resource token (T3) → inventory MCP (T4). */
const xaaChain = (subjectStep, { subjectBind = ['T1.token'], subjectTypeBind = ['T1.subject_token_type'], subjectTokenType } = {}) => [
  subjectStep,
  tokenExchange({
    id: 'T2',
    title: 'Token Exchange → id-JAG',
    tokenUrl: config.agent.tokenUrl,
    auth: agentAuth(),
    subjectBind,
    subjectTypeBind,
    subjectTokenType: subjectTokenType || TOKEN_TYPES[subjectStep.tokenType] || TOKEN_TYPES.id_token,
    audience: config.agent.audience,
    scope: config.agent.scopes,
    resource: config.agent.resource,
  }),
  resourceT3('T3', ['T2.access_token']),
  inventoryMcp('T4', ['T3.access_token']),
];

const serviceT1 = (svc) =>
  clientCredentials({
    tokenUrl: svc.t1TokenUrl,
    auth: authFrom({ clientId: svc.clientId, kid: svc.kid, privateKeyFile: svc.privateKeyFile }),
    scope: svc.scopes,
    audience: svc.t1Audience,
    resource: svc.t1Resource,
  });

const a2aChain = (t1, subjectTokenType) => {
  const a = config.a2a;
  const inv = a.inventoryAgent;
  const fin = a.financeAgent;
  const invAuth = () => authFrom({ clientId: inv.clientId, kid: inv.kid, privateKeyFile: inv.privateKeyFile });
  const finAuth = () => authFrom({ clientId: fin.clientId, kid: fin.kid, privateKeyFile: fin.privateKeyFile });
  return [
    t1,
    tokenExchange({
      id: 'T2',
      title: 'id-JAG → Finance Agent',
      from: 'Agent 1 (Inventory)',
      to: 'Org Auth Server',
      tokenUrl: a.orgTokenUrl,
      auth: invAuth(),
      subjectBind: ['T1.token', 'T1.access_token'],
      subjectTypeBind: ['T1.subject_token_type'],
      subjectTokenType,
      audience: fin.audience,
      scope: inv.idJagScopes,
      resource: fin.resource,
    }),
    jwtBearer({ id: 'T3', title: 'Inventory Agent → Finance Agent token', from: 'Agent 1 (Inventory)', to: 'Finance Agent Auth Server', tokenUrl: fin.tokenUrl, auth: invAuth(), bind: ['T2.access_token'] }),
    tokenExchange({
      id: 'T4',
      title: 'id-JAG → Finance MCP',
      from: 'Agent 2 (Finance)',
      to: 'Org Auth Server',
      tokenUrl: a.orgTokenUrl,
      auth: finAuth(),
      subjectBind: ['T3.access_token'],
      subjectTokenType: TOKEN_TYPES.access_token,
      audience: a.financeMcp.audience,
      scope: fin.idJagScopes,
      resource: a.financeMcp.resource,
    }),
    jwtBearer({ id: 'T5', title: 'Finance Access Token', from: 'Agent 2 (Finance)', to: 'Finance MCP Auth Server', tokenUrl: a.financeMcp.tokenUrl, auth: finAuth(), bind: ['T4.access_token'] }),
    mcp({
      id: 'T6',
      from: 'Finance Agent',
      to: 'Finance MCP',
      tokenBind: ['T5.access_token'],
      tool: FINANCE_TOOLS[0],
      issuer: a.financeMcp.issuer,
      jwksUri: a.financeMcp.jwksUri,
      scopes: a.financeMcp.scopes,
    }),
  ];
};

const vaultedSecretT2 = ({ title, badge, flowCfg, requested, subjectBind, subjectTokenType }) =>
  tokenExchange({
    id: 'T2',
    title,
    badge,
    to: 'Okta Org Server',
    tokenUrl: flowCfg.tokenUrl,
    auth: agentAuth(),
    subjectBind,
    subjectTokenType,
    requestedTokenType: requested,
    resource: flowCfg.resource,
    hideAudience: true,
  });

const jiraBoardHttp = (id, tokenBind) => {
  const at = config.atlassian;
  return http({
    id,
    title: 'Read Scrum Board Issues',
    badge: 'Jira',
    to: 'Atlassian Jira API',
    tokenBind,
    cloudId: at.cloudId || '',
    presets: [
      {
        value: 'board',
        label: 'Jira · Scrum board issues',
        apply: {
          method: 'GET',
          url: `${at.apiBaseUrl}/ex/jira/{cloudId}/rest/api/3/search/jql?jql=${encodeURIComponent(at.jql)}&maxResults=${at.maxResults}&fields=summary,status,assignee`,
          body: '',
        },
      },
      { value: 'custom', label: 'Custom request', apply: {} },
    ],
  });
};

const stsT2 = (resource, scope) =>
  tokenExchange({
    id: 'T2',
    title: 'Resource Token Exchange (STS)',
    badge: 'STS',
    to: 'Okta Org Server',
    tokenUrl: config.sts.tokenUrl,
    auth: agentAuth(),
    subjectBind: ['T1.token'],
    subjectTypeBind: ['T1.subject_token_type'],
    subjectTokenType: TOKEN_TYPES.id_token,
    requestedTokenType: TOKEN_TYPES.oauth_sts,
    resource,
    scope,
    hideAudience: true,
  });

// ── the catalog ──
async function authPatternSteps(pattern) {
  const agent = getAgent(pattern);
  if (!agent) return null;
  let kid = agent.kid;
  if (!kid && agent.tokenAuthMethod === 'private_key_jwt') {
    try {
      kid = await signingKid(agent);
    } catch {
      kid = '';
    }
  }
  const ap = config.authPatterns;
  const auth = () => loginAppAuth({ ...agent, kid }, { sendClientId: true });
  return [
    SUBJECTS.authp(pattern, agent, kid),
    tokenExchange({
      id: 'T2',
      title: 'Token Exchange → id-JAG',
      tokenUrl: ap.t2TokenUrl,
      auth: auth(),
      subjectBind: ['T1.token'],
      subjectTypeBind: ['T1.subject_token_type'],
      subjectTokenType: TOKEN_TYPES.id_token,
      audience: ap.audience,
      scope: ap.idJagScopes,
      resource: ap.resource,
    }),
    jwtBearer({ id: 'T3', tokenUrl: config.resource.tokenUrl, auth: auth(), bind: ['T2.access_token'] }),
    inventoryMcp('T4', ['T3.access_token']),
  ];
}

/** Ordered steps for a flow id, or null for an unknown flow. Built per request (config + DCR file may change). */
export async function flowSteps(flow) {
  if (typeof flow === 'string' && flow.startsWith('authp-')) return authPatternSteps(flow.slice('authp-'.length));

  switch (flow) {
    case 'xaa':
      return xaaChain(SUBJECTS.default());
    case 'xaa-webapp':
      return xaaChain(SUBJECTS.webapp());
    case 'hi-saml': {
      const auth = () => authFrom({ clientId: config.saml.clientId, kid: config.agent.kid, privateKeyFile: config.agent.privateKeyFile });
      return [
        SUBJECTS.saml(),
        tokenExchange({
          id: 'T2',
          title: 'SAML → Refresh Token',
          badge: 'Refresh Token',
          tokenUrl: config.saml.tokenUrl,
          auth: auth(),
          subjectBind: ['T1.token'],
          subjectTypeBind: ['T1.subject_token_type'],
          subjectTokenType: TOKEN_TYPES.saml2,
          requestedTokenType: TOKEN_TYPES.refresh_token,
          scope: 'openid offline_access',
          hideAudience: true,
        }),
        tokenExchange({
          id: 'T3',
          title: 'Refresh Token → id-JAG',
          tokenUrl: config.saml.tokenUrl,
          auth: auth(),
          subjectBind: ['T2.refresh_or_access'],
          subjectTokenType: TOKEN_TYPES.refresh_token,
          audience: config.agent.audience,
          scope: config.resource.scopes,
          resource: config.agent.resource,
        }),
        resourceT3('T4', ['T3.access_token'], config.saml.clientId),
        inventoryMcp('T5', ['T4.access_token']),
      ];
    }
    case 'secrets':
    case 'service-account': {
      const isSecret = flow === 'secrets';
      return [
        SUBJECTS.default(),
        vaultedSecretT2({
          title: isSecret ? 'Retrieve Vaulted Secret' : 'Retrieve Service Account',
          badge: isSecret ? 'Secret' : 'Service Account',
          flowCfg: isSecret ? config.secrets : config.serviceAccount,
          requested: isSecret ? TOKEN_TYPES.vaulted_secret : TOKEN_TYPES.service_account,
          subjectBind: ['T1.token'],
          subjectTokenType: TOKEN_TYPES.id_token,
        }),
        mcp({ id: 'T3', authScheme: 'basic', userBind: ['T2.cred.username'], passBind: ['T2.cred.password'], tool: INVENTORY_TOOLS[0] }),
      ];
    }
    case 'secrets-atlassian': {
      const at = config.atlassian;
      return [
        serviceT1(config.service),
        vaultedSecretT2({
          title: 'Retrieve Atlassian Credentials (from OPA)',
          badge: 'Secret',
          flowCfg: at,
          requested: TOKEN_TYPES.vaulted_secret,
          subjectBind: ['T1.access_token'],
          subjectTokenType: at.subjectTokenType,
        }),
        {
          id: 'T3',
          kind: 'atlassian_cc',
          title: 'Get Atlassian Token',
          badge: 'Atlassian',
          from: 'Agent',
          to: 'Atlassian',
          fields: [
            text('tokenUrl', 'Token URL', at.oauthTokenUrl),
            text('clientId', 'client_id', '', { bind: ['T2.cred.client_id'] }),
            text('clientSecret', 'client_secret', '', { bind: ['T2.cred.client_secret'], secret: true }),
            text('audience', 'audience', at.audience),
            text('scope', 'scope', at.scope),
          ],
          outputs: ['access_token'],
        },
        jiraBoardHttp('T4', ['T3.access_token']),
      ];
    }
    case 'secrets-atlassian-token':
      return [
        serviceT1(config.service),
        vaultedSecretT2({
          title: 'Retrieve Atlassian Access Token',
          badge: 'Secret',
          flowCfg: config.atlassianToken,
          requested: TOKEN_TYPES.vaulted_secret,
          subjectBind: ['T1.access_token'],
          subjectTokenType: config.atlassianToken.subjectTokenType,
        }),
        jiraBoardHttp('T3', ['T2.cred.access_token']),
      ];
    case 'client-credentials': {
      const svc = config.service;
      return [
        serviceT1(svc),
        tokenExchange({
          id: 'T2',
          title: 'Token Exchange → id-JAG',
          tokenUrl: svc.tokenUrl,
          auth: agentAuth(),
          subjectBind: ['T1.access_token'],
          subjectTokenType: svc.subjectTokenType,
          audience: config.agent.audience,
          scope: svc.idJagScopes,
          resource: config.agent.resource,
        }),
        resourceT3('T3', ['T2.access_token'], config.agent.clientId),
        inventoryMcp('T4', ['T3.access_token']),
      ];
    }
    case 'hi-a2a':
      return a2aChain(SUBJECTS.a2a(), TOKEN_TYPES.access_token);
    case 'nhi-a2a':
      return a2aChain(serviceT1(config.a2a.service), TOKEN_TYPES.access_token);
    case 'sts-github': {
      const gh = config.github;
      const repoUrl = `${gh.apiBaseUrl}/repos/${gh.owner || '<owner>'}/${gh.repo || '<repo>'}/pulls`;
      return [
        SUBJECTS.default(),
        stsT2(config.sts.resource, config.sts.scopes),
        http({
          id: 'T3',
          title: 'GitHub API',
          badge: 'GitHub',
          to: 'GitHub',
          tokenBind: ['T2.access_token'],
          headers: 'Accept: application/vnd.github+json',
          presets: [
            { value: 'read', label: 'Read pull requests', apply: { method: 'GET', url: `${repoUrl}?state=all&per_page=5`, body: '' } },
            {
              value: 'create',
              label: 'Create a pull request',
              apply: { method: 'POST', url: repoUrl, body: JSON.stringify({ title: gh.title, head: gh.head || '<branch>', base: gh.base, body: gh.body }, null, 2) },
            },
            { value: 'custom', label: 'Custom request', apply: {} },
          ],
        }),
      ];
    }
    case 'sts-atlassian':
      return [
        SUBJECTS.default(),
        stsT2(config.stsAtlassian.resource, config.stsAtlassian.scopes),
        atlassianMcp({ id: 'T3', cfg: config.stsAtlassian, tokenBind: ['T2.access_token'], envPrefix: 'ATLASSIAN_STS' }),
      ];
    case 'xaa-atlassian': {
      const x = config.xaaAtlassian;
      const creds = getAtlassianCredentials();
      return [
        SUBJECTS.default(),
        tokenExchange({
          id: 'T2',
          title: 'Token Exchange → id-JAG (for Atlassian)',
          tokenUrl: x.idJagTokenUrl,
          auth: agentAuth(),
          subjectBind: ['T1.token'],
          subjectTypeBind: ['T1.subject_token_type'],
          subjectTokenType: TOKEN_TYPES.id_token,
          audience: x.audience,
          scope: x.scopes,
          resource: x.resource,
        }),
        jwtBearer({
          id: 'T3',
          title: 'Access Token Request (Atlassian)',
          to: 'Atlassian Auth Server',
          tokenUrl: x.tokenUrl,
          bind: ['T2.access_token'],
          requestedTokenType: TOKEN_TYPES.access_token,
          acceptJson: true,
          authLabel: 'Atlassian (DCR) client authentication',
          auth: authFrom({
            method: creds?.clientSecret ? 'client_secret_post' : 'none',
            clientId: creds?.clientId,
            clientSecret: creds?.clientSecret,
          }),
        }),
        atlassianMcp({ id: 'T4', cfg: x, tokenBind: ['T3.access_token'], fallbackBind: ['T2.claims.aud_tenant'], envPrefix: 'ATLASSIAN_XAA' }),
      ];
    }
    case 'xaa-gcp': {
      const g = config.googleWif;
      const bq = `https://bigquery.googleapis.com/bigquery/v2/projects/${g.projectId || '<project-id>'}`;
      const sa = encodeURIComponent(g.workspaceServiceAccount || '<sa-email>');
      return [
        SUBJECTS.default(),
        tokenExchange({
          id: 'T2',
          title: 'Token Exchange → ID-JAG (for the Google Custom AS)',
          to: 'Okta Org Server',
          tokenUrl: g.idJagTokenUrl,
          auth: agentAuth(),
          subjectBind: ['T1.token'],
          subjectTypeBind: ['T1.subject_token_type'],
          subjectTokenType: TOKEN_TYPES.id_token,
          audience: g.idJagAudience,
          scope: g.scopes,
          resource: g.resource,
        }),
        jwtBearer({
          id: 'T3',
          title: 'Access Token Request (Custom AS · aud = Google)',
          to: 'Okta Custom AS',
          tokenUrl: g.tokenUrl,
          bind: ['T2.access_token'],
          auth: agentAuth(),
        }),
        tokenExchange({
          id: 'T4',
          title: 'Google STS Token Exchange → Federated Token',
          badge: 'Google Token',
          to: 'Google STS',
          tokenUrl: g.stsUrl,
          // Google STS takes no client authentication — it trusts the Okta signature.
          auth: authFrom({ method: 'none', clientId: '' }),
          subjectBind: ['T3.access_token'],
          subjectTokenType: TOKEN_TYPES.jwt,
          requestedTokenType: TOKEN_TYPES.access_token,
          audience: g.wifAudience,
          scope: g.stsScope,
        }),
        http({
          id: 'T5',
          title: 'Google Cloud API',
          badge: 'Google API',
          to: 'Google Cloud API',
          tokenBind: ['T4.access_token'],
          presets: [
            {
              value: 'bq-query',
              label: 'BigQuery · jobs.query',
              apply: { method: 'POST', url: `${bq}/queries`, body: JSON.stringify({ query: g.bigqueryQuery, useLegacySql: false, maxResults: g.maxResults }, null, 2) },
            },
            { value: 'bq-datasets', label: 'BigQuery · list datasets', apply: { method: 'GET', url: `${bq}/datasets`, body: '' } },
            {
              value: 'sa-token',
              label: 'IAM · generateAccessToken (Workspace SA)',
              apply: {
                method: 'POST',
                url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateAccessToken`,
                body: JSON.stringify({ scope: g.workspaceScopes.split(/\s+/), lifetime: '3600s' }, null, 2),
              },
            },
            { value: 'custom', label: 'Custom request', apply: {} },
          ],
        }),
      ];
    }
    default:
      return null;
  }
}

/** The browser-safe view of a flow's steps: no session readers, no configured secrets. */
export function publicSteps(steps) {
  return steps.map(({ fromSession, auth, ...s }) => ({
    ...s,
    auth: auth ? { default: auth.default, hasSecretDefault: !!auth._secret } : null,
  }));
}
