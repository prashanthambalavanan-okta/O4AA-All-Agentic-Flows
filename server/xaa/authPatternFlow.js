// Authentication Patterns — the same "HI - Cross-App Access (Login as agent)" chain
// run by four different agents, each authenticating to Okta a different way:
//
//   pkjwt  — private_key_jwt          (signed client_assertion)
//   secret — client_secret_basic/post (shared secret)
//   public — none                     (client_id only; PKCE protects the code)
//   cimd   — Client ID Metadata Document (client_id is a URL; keys via jwks_uri)
//
// clientAuth() is the one place that difference lives; T1 (login), T2 (id-JAG) and
// T3 (resource token) all go through it, so every step on the wire shows the pattern.
import { config } from '../config.js';
import { captureFormPost } from './capture.js';
import { buildClientAssertion } from './clientAssertion.js';
import { publicJwks } from '../util/privateKey.js';
import { callMcpTool } from '../mcp/inventoryServer.js';
import { validateAccessToken } from '../util/verifyToken.js';
import { buildMcpStep, summarize } from './mcpStep.js';

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export const AUTH_PATTERN_IDS = Object.keys(config.authPatterns.agents);

/** Agent config for a pattern id, or null for an unknown id. */
export function getAgent(pattern) {
  return config.authPatterns.agents[pattern] || null;
}

/** Problems that stop an agent from running (empty = ready). */
export function agentProblems(agent) {
  const p = [];
  const envPrefix = `${agent.id.toUpperCase()}_AGENT`;
  if (!agent.clientId) p.push(`set ${envPrefix}_CLIENT_ID in .env.auth-patterns`);
  if (agent.tokenAuthMethod === 'private_key_jwt') {
    if (!agent.privateKeyFile) p.push(`set ${envPrefix}_PRIVATE_KEY_FILE (or AGENT_PRIVATE_KEY_FILE)`);
    // CIMD derives its kid from the key; the console-registered pkjwt agent needs the real one.
    if (!agent.kid && agent.id !== 'cimd') p.push(`set ${envPrefix}_KID (or AGENT_KID)`);
  }
  if (agent.tokenAuthMethod.startsWith('client_secret') && !agent.clientSecret) {
    p.push(`set ${envPrefix}_CLIENT_SECRET`);
  }
  return p;
}

const METHOD_DESC = {
  private_key_jwt: 'private_key_jwt — client_assertion = a JWT signed with the agent’s private key (aud = this token endpoint)',
  client_secret_basic: 'client_secret_basic — Authorization: Basic base64(client_id:client_secret)',
  client_secret_post: 'client_secret_post — client_id + client_secret in the request body',
  none: 'none — client_id only; nothing proves which software is calling',
};

/**
 * Banner text for a step card: where (and whether) client authentication happens.
 * stage = 'authorize' (T0) | 'token' (T1/T2/T3).
 */
export function authNote(agent, stage) {
  if (stage === 'authorize') {
    const base =
      'No client authentication at /authorize — it is a browser redirect carrying only client_id, redirect_uri and the PKCE code_challenge. ' +
      `The agent authenticates at the next /token call (T1) with ${agent.tokenAuthMethod}.`;
    return agent.id === 'cimd'
      ? `${base} CIMD: client_id is a URL — Okta fetches that metadata document here to validate redirect_uri and learn the jwks_uri.`
      : base;
  }
  const desc = METHOD_DESC[agent.tokenAuthMethod] || agent.tokenAuthMethod;
  return `Client authentication (${agent.label}): ${desc}.${
    agent.id === 'cimd' && agent.tokenAuthMethod === 'private_key_jwt'
      ? ' Okta verifies the assertion against the jwks_uri named in the client_id metadata document.'
      : ''
  }`;
}

/** The kid an agent signs with — for CIMD, the thumbprint published at jwks_uri. */
export async function signingKid(agent) {
  if (agent.kid) return agent.kid;
  return (await publicJwks({ privateKeyFile: agent.privateKeyFile })).kid;
}

/**
 * How `agent` authenticates a request to `tokenUrl`. Returns the extra headers and
 * body params to merge into the token request.
 */
export async function clientAuth(agent, tokenUrl) {
  switch (agent.tokenAuthMethod) {
    case 'private_key_jwt':
      return {
        headers: {},
        params: {
          client_id: agent.clientId,
          client_assertion_type: CLIENT_ASSERTION_TYPE,
          client_assertion: await buildClientAssertion({
            clientId: agent.clientId,
            audience: tokenUrl,
            kid: await signingKid(agent),
            privateKeyFile: agent.privateKeyFile,
          }),
        },
      };
    case 'client_secret_basic': {
      // RFC 6749 §2.3.1: form-urlencode id and secret before base64.
      const creds = `${encodeURIComponent(agent.clientId)}:${encodeURIComponent(agent.clientSecret)}`;
      return { headers: { Authorization: `Basic ${Buffer.from(creds).toString('base64')}` }, params: {} };
    }
    case 'client_secret_post':
      return { headers: {}, params: { client_id: agent.clientId, client_secret: agent.clientSecret } };
    case 'none':
    default:
      return { headers: {}, params: { client_id: agent.clientId } };
  }
}

// Never show the shared secret in the sequence view / curl snippet.
function redactSecret(captured, agent) {
  if (!agent.clientSecret) return captured;
  const secret = agent.clientSecret;
  const enc = encodeURIComponent(secret);
  const scrub = (s) => (typeof s === 'string' ? s.split(enc).join('<client_secret>').split(secret).join('<client_secret>') : s);
  captured.request.body = scrub(captured.request.body);
  captured.code = scrub(captured.code);
  const hdrs = captured.request.headers;
  if (hdrs.Authorization?.startsWith('Basic ')) {
    hdrs.Authorization = 'Basic <base64(client_id:client_secret)>';
    captured.code = captured.code.replace(/Authorization: Basic [A-Za-z0-9+/=]+/, 'Authorization: Basic <base64(client_id:client_secret)>');
  }
  return captured;
}

// A step that never reached the wire (e.g. signing failed) — shown as a failed card.
function failedStep(meta, url, err) {
  return {
    ...meta,
    ok: false,
    request: { method: 'POST', url, headers: {}, body: '(request not sent — client authentication could not be built)' },
    response: { status: 0, headers: {}, body: { error: 'client_auth_error', error_description: err.message } },
    token: null,
    code: '',
  };
}

async function postAs(agent, meta, url, params) {
  let auth;
  try {
    auth = await clientAuth(agent, url);
  } catch (err) {
    console.error(`[${meta.id}] ${agent.id} client auth failed:`, err);
    return { step: failedStep(meta, url, err), responseBody: null, ok: false };
  }
  const { captured, responseBody, ok } = await captureFormPost(meta, url, auth.headers, { ...params, ...auth.params });
  captured.note = authNote(agent, 'token');
  return { step: redactSecret(captured, agent), responseBody, ok };
}

/** T2 — token-exchange: id_token → id-JAG, authenticated with the agent's own pattern. */
export async function requestPatternIdJag(agent, idToken) {
  const ap = config.authPatterns;
  const params = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    subject_token: idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    requested_token_type: TOKEN_TYPE_ID_JAG,
    audience: ap.audience,
    scope: ap.idJagScopes,
  };
  if (ap.resource) params.resource = ap.resource;
  const r = await postAs(
    agent,
    { id: 'T2', title: 'Token Exchange', badge: 'ID-JAG', from: 'Agent', to: 'IdP', tokenField: 'access_token' },
    ap.t2TokenUrl,
    params
  );
  return { ...r, idJag: r.ok ? r.responseBody.access_token : null };
}

/** T3 — jwt-bearer: id-JAG → resource access token, same agent, same pattern. */
export async function redeemPatternIdJag(agent, idJag) {
  const r = await postAs(
    agent,
    { id: 'T3', title: 'Access Token Request', badge: 'Access Token', from: 'Agent', to: 'Auth Server', tokenField: 'access_token' },
    config.resource.tokenUrl,
    { grant_type: GRANT_JWT_BEARER, assertion: idJag }
  );
  return { ...r, accessToken: r.ok ? r.responseBody.access_token : null };
}

/** T2 → T3 → T4 for one pattern. T0/T1 (the agent's own login) are prepended client-side. */
export async function runAuthPatternFlow(pattern, idToken, toolName, steps) {
  const agent = getAgent(pattern);
  if (!agent) return `Unknown authentication pattern '${pattern}'.`;
  const problems = agentProblems(agent);
  if (problems.length) return `The ${agent.label} agent is not configured — ${problems.join('; ')}.`;

  const t2 = await requestPatternIdJag(agent, idToken);
  steps.push(t2.step);
  if (!t2.ok) return 'The token exchange (id-JAG) request failed — see step T2 for the error response.';

  const t3 = await redeemPatternIdJag(agent, t2.idJag);
  steps.push(t3.step);
  if (!t3.ok) return 'The access token request failed — see step T3 for the error response.';

  const requiredScopes = (config.resource.scopes || '').split(' ').filter(Boolean);
  const validation = await validateAccessToken(t3.accessToken, requiredScopes);
  if (!validation.ok) {
    steps.push(buildMcpStep(toolName, t3.accessToken, null, validation));
    return validation.verified
      ? `Access denied: the token is missing the required scope(s) ${requiredScopes.join(', ')}. See step T4.`
      : `Access denied: the access token failed validation${validation.error ? ` (${validation.error})` : ''}. See step T4.`;
  }

  const result = await callMcpTool(toolName);
  steps.push(buildMcpStep(toolName, t3.accessToken, result, validation));
  return summarize(toolName, result);
}

/** /api/me payload: per-pattern login state + whether each agent is configured. */
export function authPatternsMe(session) {
  const out = {};
  for (const id of AUTH_PATTERN_IDS) {
    const s = session.authp?.[id];
    out[id] = {
      configured: agentProblems(getAgent(id)).length === 0,
      authenticated: !!s?.idToken,
      user: s?.user || null,
      loginStep: s?.loginStep || null,
    };
  }
  return out;
}
