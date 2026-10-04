import { config } from '../config.js';
import { captureFormPost } from './capture.js';
import { buildClientAssertion } from './clientAssertion.js';

const GRANT_CLIENT_CREDENTIALS = 'client_credentials';
const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * T1 — Client Credentials. The service app authenticates with private_key_jwt and
 * obtains its own access token. `cfg` is the service config (config.service for the
 * NHI flow, config.a2a.service for NHI - A2A).
 *
 * This function's cfg object *is* the override seam the step-by-step runner uses: it
 * passes `{ ...config.service, ...overrides }`, which is why `privateKeyPem` is read
 * from cfg here (it is absent from the config objects, so the chat path is unchanged).
 */
export async function requestServiceToken(cfg = config.service) {
  const clientAssertion = await buildClientAssertion({
    clientId: cfg.clientId,
    audience: cfg.assertionAudience ?? cfg.t1TokenUrl,
    kid: cfg.kid,
    privateKeyFile: cfg.privateKeyFile,
    privateKeyPem: cfg.privateKeyPem,
  });

  const bodyParams = {
    grant_type: GRANT_CLIENT_CREDENTIALS,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (cfg.scopes) bodyParams.scope = cfg.scopes;
  if (cfg.t1Audience) bodyParams.audience = cfg.t1Audience;
  if (cfg.t1Resource) bodyParams.resource = cfg.t1Resource;

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T1', title: 'Client Credentials', badge: 'Access Token', from: 'Service App', to: 'Okta', tokenField: 'access_token' },
    cfg.t1TokenUrl,
    {},
    bodyParams
  );

  return { step: captured, token: ok ? responseBody.access_token : null, ok };
}

/**
 * T2 — Token Exchange → id-JAG, using the service token as the subject token.
 *
 * `ov` — per-run overrides from the step-by-step runner; every field falls back to the
 * value used today, so the chat path (no `ov`) is unchanged. Note the assertion audience
 * here is the SERVICE token endpoint, not `config.agent.assertionAudience` — which is why
 * this stays on `buildClientAssertion` rather than the shared agent helper.
 */
export async function requestServiceIdJag(serviceToken, ov = {}) {
  const tokenUrl = ov.tokenUrl ?? config.service.tokenUrl;
  const audience = ov.audience ?? config.agent.audience;
  const subjectTokenType = ov.subjectTokenType ?? config.service.subjectTokenType;
  const scope = ov.scope ?? config.service.idJagScopes;
  const resource = ov.resource ?? config.agent.resource;

  // T2 client_assertion: iss/sub = AGENT_CLIENT_ID, signed with the AGENT cert.
  const clientAssertion = await buildClientAssertion({
    clientId: ov.clientId ?? config.agent.clientId,
    audience: ov.assertionAudience ?? tokenUrl,
    kid: ov.kid ?? config.agent.kid,
    privateKeyFile: ov.privateKeyFile ?? config.agent.privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    subject_token: serviceToken,
    subject_token_type: subjectTokenType,
    requested_token_type: TOKEN_TYPE_ID_JAG,
    audience,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };
  if (scope) bodyParams.scope = scope;
  if (resource) bodyParams.resource = resource;

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T2', title: 'Token Exchange', badge: 'ID-JAG', from: 'Agent', to: 'IdP', tokenField: 'access_token' },
    tokenUrl,
    {},
    bodyParams
  );

  return { step: captured, idJag: ok ? responseBody.access_token : null, ok };
}

/**
 * T3 — JWT-Bearer → Access Token at the resource auth server. Authenticated as the
 * agent: client_assertion iss/sub = AGENT_CLIENT_ID, signed with the agent cert.
 */
export async function exchangeServiceIdJag(idJag, ov = {}) {
  const tokenUrl = ov.tokenUrl ?? config.resource.tokenUrl;

  const clientAssertion = await buildClientAssertion({
    clientId: ov.clientId ?? config.agent.clientId,
    audience: ov.assertionAudience ?? tokenUrl,
    kid: ov.kid ?? config.agent.kid,
    privateKeyFile: ov.privateKeyFile ?? config.agent.privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });

  const bodyParams = {
    grant_type: GRANT_JWT_BEARER,
    assertion: idJag,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T3', title: 'Access Token Request', badge: 'Access Token', from: 'Agent', to: 'Auth Server', tokenField: 'access_token' },
    tokenUrl,
    {},
    bodyParams
  );

  return { step: captured, accessToken: ok ? responseBody.access_token : null, ok };
}
