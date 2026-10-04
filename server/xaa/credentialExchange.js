import { config } from '../config.js';
import { captureFormPost } from './capture.js';
import { buildClientAssertion } from './clientAssertion.js';

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const TOKEN_TYPE_VAULTED_SECRET = 'urn:okta:params:oauth:token-type:vaulted-secret';
const TOKEN_TYPE_SERVICE_ACCOUNT = 'urn:okta:params:oauth:token-type:service-account';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

// Pull a username/password out of the returned credential object. Service accounts
// return { username, password }; vaulted secrets return arbitrary key/value pairs,
// so prefer username/password keys and fall back to the first two values.
function extractCreds(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj);
  const username = obj.username ?? obj.user ?? (keys[0] ? obj[keys[0]] : undefined);
  const password = obj.password ?? obj.pass ?? (keys[1] ? obj[keys[1]] : undefined);
  if (username == null || password == null) return null;
  return { username: String(username), password: String(password) };
}

/**
 * Shared T2 for the Secrets / Service Account flows: exchange the user's id_token
 * at the org token endpoint for vaulted static credentials, authenticating with a
 * private_key_jwt signed by the agent cert.
 *
 * `ov` — per-run overrides from the step-by-step runner; every field falls back to the
 * value used today, so the chat path (which passes no `ov`) is unchanged. Note this is
 * also where a pasted PEM becomes usable: the assertion build below passed no
 * `privateKeyFile` at all before, relying on buildClientAssertion's default.
 */
async function requestVaultedCredential({ flowCfg, requestedTokenType, credentialField, step, ov = {} }) {
  const subjectTokenType = step.subjectTokenType ?? TOKEN_TYPE_ID_TOKEN;
  const tokenUrl = ov.tokenUrl ?? flowCfg.tokenUrl;
  const resource = ov.resource ?? flowCfg.resource;

  const clientAssertion = await buildClientAssertion({
    clientId: ov.clientId ?? config.agent.clientId,
    audience: ov.assertionAudience ?? flowCfg.assertionAudience,
    kid: ov.kid ?? config.agent.kid,
    privateKeyFile: ov.privateKeyFile ?? config.agent.privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });

  const bodyParams = {
    grant_type: GRANT_TOKEN_EXCHANGE,
    requested_token_type: requestedTokenType,
    subject_token: step.idToken,
    subject_token_type: subjectTokenType,
    resource,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  };

  const { captured, responseBody, ok } = await captureFormPost(
    { id: 'T2', title: step.title, badge: step.badge, from: 'Agent', to: 'Okta Org Server' },
    tokenUrl,
    {},
    bodyParams
  );

  const credObj = ok && responseBody && typeof responseBody === 'object' ? responseBody[credentialField] : null;
  const creds = extractCreds(credObj);
  // A token-only secret has a single field, which extractCreds (needs two) rejects.
  const hasRaw = !!credObj && typeof credObj === 'object' && Object.keys(credObj).length > 0;
  return { step: captured, creds, raw: credObj, ok: ok && (step.rawOk ? hasRaw : !!creds) };
}

/** T2 (Secrets) — exchange id_token for a vaulted secret. */
export function requestVaultedSecret(idToken, ov = {}) {
  return requestVaultedCredential({
    flowCfg: config.secrets,
    requestedTokenType: TOKEN_TYPE_VAULTED_SECRET,
    credentialField: 'vaulted_secret',
    step: { idToken, title: 'Retrieve Vaulted Secret', badge: 'Secret' },
    ov,
  });
}

/** T2 (Service Account) — exchange id_token for service account credentials. */
export function requestServiceAccount(idToken, ov = {}) {
  return requestVaultedCredential({
    flowCfg: config.serviceAccount,
    requestedTokenType: TOKEN_TYPE_SERVICE_ACCOUNT,
    credentialField: 'service_account',
    step: { idToken, title: 'Retrieve Service Account', badge: 'Service Account' },
    ov,
  });
}

/**
 * T2 (NHI · Atlassian) — exchange the service app's access token (from T1
 * client_credentials) for the vaulted Atlassian client id/secret. No user involved.
 */
export function requestAtlassianSecret(serviceToken, ov = {}) {
  return requestVaultedCredential({
    flowCfg: config.atlassian,
    requestedTokenType: TOKEN_TYPE_VAULTED_SECRET,
    credentialField: 'vaulted_secret',
    step: {
      idToken: serviceToken,
      subjectTokenType: config.atlassian.subjectTokenType,
      title: 'Retrieve Atlassian Credentials (from OPA)',
      badge: 'Secret',
    },
    ov,
  });
}

/**
 * T2 (NHI · Atlassian token) — exchange the service app's access token for a vaulted
 * secret that holds the Atlassian access token itself.
 */
export function requestAtlassianTokenSecret(serviceToken, ov = {}) {
  return requestVaultedCredential({
    flowCfg: config.atlassianToken,
    requestedTokenType: TOKEN_TYPE_VAULTED_SECRET,
    credentialField: 'vaulted_secret',
    step: {
      idToken: serviceToken,
      subjectTokenType: config.atlassianToken.subjectTokenType,
      title: 'Retrieve Atlassian Access Token',
      badge: 'Secret',
      rawOk: true,
    },
    ov,
  });
}
