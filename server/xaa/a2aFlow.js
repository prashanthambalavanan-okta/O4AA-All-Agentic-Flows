import { config } from '../config.js';
import { captureFormPost } from './capture.js';
import { buildClientAssertion } from './clientAssertion.js';

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';
const TOKEN_TYPE_ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

const agent1 = () => config.a2a.inventoryAgent; // Inventory Agent
const agent2 = () => config.a2a.financeAgent; // Finance Agent (+ its auth server)
const mcp = () => config.a2a.financeMcp; // Finance MCP resource server
const orgUrl = () => config.a2a.orgTokenUrl;

/**
 * T2 — Agent 1 (Inventory) requests an id-JAG at the ORG auth server, targeting
 * Agent 2 (Finance). audience = Agent 2's auth server, resource = Agent 2 resource.
 * subjectTokenType is access_token (HI user access token / NHI service token).
 *
 * `ov` — per-run overrides from the step-by-step runner; every field falls back to the
 * value used today, so the chat path (which passes no `ov`) is unchanged. Note the
 * assertion audience tracks the (possibly overridden) token endpoint, which is what
 * `orgUrl()` already was.
 */
export async function requestIdJagForInventory(subjectToken, subjectTokenType, ov = {}) {
  const tokenUrl = ov.tokenUrl ?? orgUrl();
  const audience = ov.audience ?? agent2().audience;
  const scope = ov.scope ?? agent1().idJagScopes;
  const resource = ov.resource ?? agent2().resource;

  const clientAssertion = await buildClientAssertion({
    clientId: ov.clientId ?? agent1().clientId,
    audience: ov.assertionAudience ?? tokenUrl,
    kid: ov.kid ?? agent1().kid,
    privateKeyFile: ov.privateKeyFile ?? agent1().privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    subject_token: subjectToken,
    subject_token_type: subjectTokenType,
    requested_token_type: TOKEN_TYPE_ID_JAG,
    audience,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (scope) bodyParams.scope = scope;
  if (resource) bodyParams.resource = resource;

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T2', title: 'id-JAG → Agent 2', badge: 'ID-JAG', from: 'Agent 1 (Inventory)', to: 'Org Auth Server', tokenField: 'access_token' },
    tokenUrl,
    {},
    bodyParams
  );
  return { step: captured, idJag: ok ? responseBody.access_token : null, ok };
}

/**
 * T3 — Agent 1 redeems the id-JAG at Agent 2's auth server, getting a token for
 * Agent 1 to invoke Agent 2.
 *
 * `ov` — per-run overrides from the step-by-step runner, defaulted to today's config.
 */
export async function exchangeForInventoryToken(idJag, ov = {}) {
  const tokenUrl = ov.tokenUrl ?? agent2().tokenUrl;

  const clientAssertion = await buildClientAssertion({
    clientId: ov.clientId ?? agent1().clientId,
    audience: ov.assertionAudience ?? tokenUrl,
    kid: ov.kid ?? agent1().kid,
    privateKeyFile: ov.privateKeyFile ?? agent1().privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });

  const bodyParams = {
    grant_type: GRANT_JWT_BEARER,
    assertion: idJag,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T3', title: 'Agent 1 → Agent 2 Token', badge: 'Access Token', from: 'Agent 1 (Inventory)', to: 'Agent 2 Auth Server', tokenField: 'access_token' },
    tokenUrl,
    {},
    bodyParams
  );
  return { step: captured, accessToken: ok ? responseBody.access_token : null, ok };
}

/**
 * T4 — Agent 2 (Finance) requests an id-JAG at the ORG auth server, targeting the
 * Finance MCP resource server, using its Agent 1→Agent 2 token (T3) as the subject.
 *
 * `ov` — per-run overrides from the step-by-step runner, defaulted to today's config.
 */
export async function requestIdJagForFinance(agent1ToAgent2Token, ov = {}) {
  const tokenUrl = ov.tokenUrl ?? orgUrl();
  const audience = ov.audience ?? mcp().audience;
  const subjectTokenType = ov.subjectTokenType ?? TOKEN_TYPE_ACCESS;
  const scope = ov.scope ?? agent2().idJagScopes;
  const resource = ov.resource ?? mcp().resource;

  const clientAssertion = await buildClientAssertion({
    clientId: ov.clientId ?? agent2().clientId,
    audience: ov.assertionAudience ?? tokenUrl,
    kid: ov.kid ?? agent2().kid,
    privateKeyFile: ov.privateKeyFile ?? agent2().privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    subject_token: agent1ToAgent2Token,
    subject_token_type: subjectTokenType,
    requested_token_type: TOKEN_TYPE_ID_JAG,
    audience,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (scope) bodyParams.scope = scope;
  if (resource) bodyParams.resource = resource;

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T4', title: 'id-JAG → Finance MCP', badge: 'ID-JAG', from: 'Agent 2 (Finance)', to: 'Org Auth Server', tokenField: 'access_token' },
    tokenUrl,
    {},
    bodyParams
  );
  return { step: captured, idJag: ok ? responseBody.access_token : null, ok };
}

/**
 * T5 — Agent 2 redeems the id-JAG at the Finance MCP auth server for the final
 * access token used to call the Finance MCP.
 *
 * `ov` — per-run overrides from the step-by-step runner, defaulted to today's config.
 */
export async function exchangeForFinanceToken(idJag, ov = {}) {
  const tokenUrl = ov.tokenUrl ?? mcp().tokenUrl;

  const clientAssertion = await buildClientAssertion({
    clientId: ov.clientId ?? agent2().clientId,
    audience: ov.assertionAudience ?? tokenUrl,
    kid: ov.kid ?? agent2().kid,
    privateKeyFile: ov.privateKeyFile ?? agent2().privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });

  const bodyParams = {
    grant_type: GRANT_JWT_BEARER,
    assertion: idJag,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T5', title: 'Finance Access Token', badge: 'Access Token', from: 'Agent 2 (Finance)', to: 'Finance MCP Auth Server', tokenField: 'access_token' },
    tokenUrl,
    {},
    bodyParams
  );
  return { step: captured, accessToken: ok ? responseBody.access_token : null, ok };
}
