import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from project root regardless of where node was launched from.
// override: true so the file is the single source of truth — stale exports left in
// the launching shell (OKTA_ISSUER, AGENT_AUTH_SERVER, ...) would otherwise win and
// silently point the flows at the wrong org.
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), override: true });
// A2A (agent-to-agent) config lives in its own file to keep it separate.
dotenv.config({ path: path.resolve(__dirname, '..', '.env.a2a'), override: true });

const REQUIRED = [
  'SESSION_SECRET',
  'OKTA_ISSUER',
  'OKTA_CLIENT_ID',
  'OKTA_REDIRECT_URI',
  'RESOURCE_AUTH_SERVER',
  'AGENT_CLIENT_ID',
  'AGENT_PRIVATE_KEY_FILE',
  'AGENT_KID',
];

// Build the standard Okta token endpoint from an authorization server base URL.
// Custom auth server: https://org.okta.com/oauth2/<id>  -> .../oauth2/<id>/v1/token
// Org auth server:    https://org.okta.com              -> .../oauth2/v1/token
const tokenEndpoint = (authServer) => {
  if (!authServer) return undefined;
  const base = authServer.replace(/\/$/, '');
  return base.includes('/oauth2') ? `${base}/v1/token` : `${base}/oauth2/v1/token`;
};

// Same shape for the JWKS (public keys) endpoint used to verify access tokens.
const keysEndpoint = (authServer) => {
  if (!authServer) return undefined;
  const base = authServer.replace(/\/$/, '');
  return base.includes('/oauth2') ? `${base}/v1/keys` : `${base}/oauth2/v1/keys`;
};

// Agent auth server (IdP where the user logged in / token-exchange happens).
// Defaults to OKTA_ISSUER since that's the same authorization server.
const AGENT_AUTH_SERVER = process.env.AGENT_AUTH_SERVER || process.env.OKTA_ISSUER;
const RESOURCE_AUTH_SERVER = process.env.RESOURCE_AUTH_SERVER;

// ── One key for the whole app ──
// The login web apps authenticate with private_key_jwt using the SAME keypair the
// agent already signs its client assertions with, so there is only ever ONE public
// JWK to register in Okta (on the web app and on the agent app). Override
// OKTA_PRIVATE_KEY_FILE / OKTA_KID only if you deliberately want a separate key.
const AGENT_PRIVATE_KEY_FILE = process.env.AGENT_PRIVATE_KEY_FILE;
const AGENT_KID = process.env.AGENT_KID;

// Secrets & Service Account token exchanges MUST use the ORG authorization server
// token endpoint (/oauth2/v1/token), never a custom one. Derive the org base by
// stripping any /oauth2/... suffix from the issuer.
const ORG_BASE = (process.env.OKTA_ORG_URL || process.env.OKTA_ISSUER || '')
  .replace(/\/oauth2\/.*$/, '')
  .replace(/\/$/, '');
const ORG_TOKEN_URL = ORG_BASE ? `${ORG_BASE}/oauth2/v1/token` : undefined;
const ORG_REVOKE_URL = ORG_BASE ? `${ORG_BASE}/oauth2/v1/revoke` : undefined;

// ── Agent-to-Agent (A2A) — config from .env.a2a ──
// Two agents, each behind its own authorization server (Inventory + Finance).
// ALL id-JAG (token-exchange) requests go to the ORG authorization server.
const ORG_AUTH_SERVER = process.env.ORG_AUTH_SERVER || AGENT_AUTH_SERVER;
const FINANCE_AGENT_AUTH_SERVER = process.env.FINANCE_AGENT_AUTH_SERVER; // Agent 2's auth server
const FINANCE_MCP_AUTH_SERVER = process.env.FINANCE_MCP_AUTH_SERVER; // Finance MCP resource server
const trimUrl = (u) => (u ? u.replace(/\/$/, '') : undefined);

// The shipped .env.a2a.example ships placeholder values ("https://your-org.okta.com/
// oauth2/your-auth-server-id"). Treat those as unset so an unconfigured A2A file just
// disables A2A instead of pointing discovery / token calls at a host that isn't yours.
const PLACEHOLDER = /your-org\.okta\.com|your-[a-z-]*auth-server-id|your-.*-client-id/i;
const real = (v) => (v && !PLACEHOLDER.test(v) ? v : undefined);

const A2A_OKTA_ISSUER = real(process.env.A2A_OKTA_ISSUER);

export const config = {
  port: Number(process.env.PORT || 8080),
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8080}`,
  sessionSecret: process.env.SESSION_SECRET,

  // T1 — user login. The chat web app is a CONFIDENTIAL client that authenticates
  // with private_key_jwt (public/private key), not a client secret.
  okta: {
    issuer: process.env.OKTA_ISSUER,
    clientId: process.env.OKTA_CLIENT_ID,
    redirectUri: process.env.OKTA_REDIRECT_URI,
    scopes: process.env.OKTA_SCOPES || 'openid profile email',
    // 'private_key_jwt' (default) or 'client_secret_basic' / 'client_secret_post'
    // as an escape hatch if the Okta app hasn't been switched over yet.
    tokenAuthMethod: process.env.OKTA_TOKEN_AUTH_METHOD || 'private_key_jwt',
    // Defaults to the agent cert — same key, no extra application key to manage.
    privateKeyFile: process.env.OKTA_PRIVATE_KEY_FILE || AGENT_PRIVATE_KEY_FILE,
    kid: process.env.OKTA_KID || AGENT_KID,
    // 'aud' of the login client_assertion = the token endpoint it is sent to.
    assertionAudience: tokenEndpoint(process.env.OKTA_ISSUER),
    // Only read when tokenAuthMethod is a client_secret_* method.
    clientSecret: process.env.OKTA_CLIENT_SECRET,
  },

  // HI - Cross-App Access (Login as Web App). A separate confidential web app,
  // authenticated with a client secret (not private_key_jwt) — its /authorize call
  // carries a 'resource' param, and its ACCESS token (not id_token) is the T2
  // token-exchange subject for the same agent/resource chain as the 'xaa' flow.
  webapp: {
    issuer: process.env.WEBAPP_ISSUER || process.env.OKTA_ISSUER,
    clientId: process.env.WEBAPP_CLIENT_ID,
    clientSecret: process.env.WEBAPP_CLIENT_SECRET,
    redirectUri: process.env.WEBAPP_REDIRECT_URI,
    scopes: process.env.WEBAPP_SCOPES || 'openid profile email',
    tokenAuthMethod: process.env.WEBAPP_TOKEN_AUTH_METHOD || 'client_secret_basic',
    // 'resource' param on the webapp's own /authorize call (RFC 8707).
    resource: process.env.WEBAPP_RESOURCE || undefined,
  },

  // T2 — token exchange (private_key_jwt) at the agent's authorization server
  agent: {
    authServer: AGENT_AUTH_SERVER,
    tokenUrl: tokenEndpoint(AGENT_AUTH_SERVER),
    clientId: process.env.AGENT_CLIENT_ID,
    privateKeyFile: process.env.AGENT_PRIVATE_KEY_FILE,
    kid: process.env.AGENT_KID,
    // 'aud' of the client_assertion JWT = the token endpoint it's sent to (RFC 7523).
    assertionAudience: tokenEndpoint(AGENT_AUTH_SERVER),
    // 'audience' request param at T2 = the resource the id-JAG is minted for.
    // Set RESOURCE_AUDIENCE when Okta expects the resource authorization server's
    // configured Audience value (Security → API → Authorization Servers → Settings)
    // or its token endpoint, rather than its issuer URL; otherwise it falls back to
    // the issuer URL.
    audience: process.env.RESOURCE_AUDIENCE || RESOURCE_AUTH_SERVER,
    resource: process.env.XAA_RESOURCE || undefined,
    scopes: process.env.XAA_SCOPES || 'inventory:read',
  },

  // T3 — jwt-bearer (private_key_jwt, same agent cert) at the resource's authorization server
  resource: {
    authServer: RESOURCE_AUTH_SERVER,
    tokenUrl: tokenEndpoint(RESOURCE_AUTH_SERVER),
    // For T4 access-token validation: the issuer (iss claim) and JWKS endpoint.
    issuer: RESOURCE_AUTH_SERVER ? RESOURCE_AUTH_SERVER.replace(/\/$/, '') : undefined,
    jwksUri: keysEndpoint(RESOURCE_AUTH_SERVER),
    // T3 authenticates as the agent client (same client_id embedded in the id-JAG).
    clientId: process.env.AGENT_CLIENT_ID,
    // 'aud' of the T3 client_assertion = the resource token endpoint it's sent to.
    assertionAudience: tokenEndpoint(RESOURCE_AUTH_SERVER),
    // Same signing cert as the agent; override only if the resource client uses a different kid.
    kid: process.env.RESOURCE_KID || process.env.AGENT_KID,
    scopes: process.env.RESOURCE_SCOPES || 'inventory:read',
  },

  // HI - SAML - Cross-App Access. T1 SAML IdP-initiated login (Okta POSTs the
  // assertion to the ACS), then: SAML assertion → refresh_token (T2) →
  // id-JAG (T3) → resource access token (T4, reuses the XAA jwt-bearer step) →
  // token-validated MCP call (T5).
  saml: {
    // Where the browser is sent to start SAML SSO (Okta IdP-initiated URL).
    idpInitiatedUrl: process.env.SAML_IDP_INITIATED_URL,
    // Assertion Consumer Service path Okta POSTs the SAMLResponse to.
    // Give Okta:  <APP_BASE_URL>/api/saml/acs
    acsPath: '/api/saml/acs',
    // T2 (saml→refresh) and T3 (refresh→id-jag) are minted at the agent/org auth
    // server, same as the OIDC Cross-App Access flow. Override with SAML_AUTH_SERVER.
    tokenUrl: tokenEndpoint(process.env.SAML_AUTH_SERVER || AGENT_AUTH_SERVER),
    // Dedicated agent client_id for this flow's T2/T3 mint and T4 redeem — a separate
    // Okta app registration from AGENT_CLIENT_ID, but signing with the SAME agent cert
    // (AGENT_PRIVATE_KEY_FILE/AGENT_KID). Falls back to AGENT_CLIENT_ID if unset.
    clientId: process.env.AGENT_CLIENT_ID_SAML || process.env.AGENT_CLIENT_ID,
  },

  // A2A (from .env.a2a): all id-JAG requests go to the ORG auth server; each agent
  // redeems / is validated at its own authorization server. Certs default to the agent cert.
  a2a: {
    orgTokenUrl: tokenEndpoint(ORG_AUTH_SERVER),

    // A2A's own OIDC web app (its own client id). Used when a user selects an A2A
    // flow; /authorize includes the Inventory resource. Also private_key_jwt, and
    // it reuses the agent cert too — still just the one key.
    okta: {
      issuer: A2A_OKTA_ISSUER,
      clientId: real(process.env.A2A_OKTA_CLIENT_ID),
      redirectUri: process.env.A2A_OKTA_REDIRECT_URI,
      scopes: process.env.A2A_OKTA_SCOPES || 'openid profile email',
      tokenAuthMethod:
        process.env.A2A_OKTA_TOKEN_AUTH_METHOD || process.env.OKTA_TOKEN_AUTH_METHOD || 'private_key_jwt',
      privateKeyFile:
        process.env.A2A_OKTA_PRIVATE_KEY_FILE || process.env.OKTA_PRIVATE_KEY_FILE || AGENT_PRIVATE_KEY_FILE,
      kid: process.env.A2A_OKTA_KID || process.env.OKTA_KID || AGENT_KID,
      assertionAudience: tokenEndpoint(A2A_OKTA_ISSUER),
      clientSecret: process.env.A2A_OKTA_CLIENT_SECRET,
    },

    // Service app for NHI - A2A (T1 client_credentials) — copied from the service app config.
    service: {
      clientId: process.env.A2A_SERVICE_CLIENT_ID,
      privateKeyFile: process.env.A2A_SERVICE_PRIVATE_KEY_FILE || process.env.SERVICE_PRIVATE_KEY_FILE,
      kid: process.env.A2A_SERVICE_KID || process.env.SERVICE_KID,
      t1TokenUrl: tokenEndpoint(process.env.A2A_SERVICE_ISSUER || ORG_AUTH_SERVER),
      t1Audience: process.env.A2A_SERVICE_AUDIENCE || undefined,
      t1Resource: process.env.A2A_SERVICE_RESOURCE || undefined,
      scopes: process.env.A2A_SERVICE_SCOPES || undefined,
      subjectTokenType:
        process.env.A2A_SERVICE_SUBJECT_TOKEN_TYPE || 'urn:ietf:params:oauth:token-type:access_token',
    },

    // Agent 1 (Inventory) — requests T2 id-JAG (@ Org), redeems T3 @ Agent 2's auth server.
    inventoryAgent: {
      clientId: process.env.INVENTORY_AGENT_CLIENT_ID,
      privateKeyFile: process.env.INVENTORY_AGENT_PRIVATE_KEY_FILE || process.env.AGENT_PRIVATE_KEY_FILE,
      kid: process.env.INVENTORY_AGENT_KID || process.env.AGENT_KID,
      idJagScopes: process.env.INVENTORY_AGENT_IDJAG_SCOPES || undefined, // T2 scope
      // Added to the T1 A2A-login /authorize call (Agent 1 / Inventory resource).
      resource: process.env.INVENTORY_AGENT_RESOURCE || undefined,
    },

    // Agent 2 (Finance) — its auth server is the T2 audience + T3 redeem endpoint; it also
    // requests T4 id-JAG (@ Org) and redeems T5 at the Finance MCP auth server.
    financeAgent: {
      clientId: process.env.FINANCE_AGENT_CLIENT_ID,
      privateKeyFile: process.env.FINANCE_AGENT_PRIVATE_KEY_FILE || process.env.AGENT_PRIVATE_KEY_FILE,
      kid: process.env.FINANCE_AGENT_KID || process.env.AGENT_KID,
      authServer: FINANCE_AGENT_AUTH_SERVER,
      tokenUrl: tokenEndpoint(FINANCE_AGENT_AUTH_SERVER), // T3 redeem endpoint
      audience: trimUrl(FINANCE_AGENT_AUTH_SERVER), // T2 id-JAG audience
      resource: process.env.FINANCE_AGENT_RESOURCE || undefined, // T2 id-JAG resource
      idJagScopes: process.env.FINANCE_AGENT_IDJAG_SCOPES || undefined, // T4 scope
    },

    // Finance MCP resource server — T4 id-JAG audience, T5 redeem endpoint, T6 validation.
    financeMcp: {
      authServer: FINANCE_MCP_AUTH_SERVER,
      tokenUrl: tokenEndpoint(FINANCE_MCP_AUTH_SERVER), // T5 redeem endpoint
      audience: trimUrl(FINANCE_MCP_AUTH_SERVER), // T4 id-JAG audience
      resource: process.env.FINANCE_MCP_RESOURCE || undefined, // optional T4 id-JAG resource
      issuer: trimUrl(FINANCE_MCP_AUTH_SERVER),
      jwksUri: keysEndpoint(FINANCE_MCP_AUTH_SERVER),
      scopes: process.env.FINANCE_MCP_SCOPES || undefined, // T6 enforced scope
    },
  },

  // Service App (Client Credentials) flow — a headless service identity instead
  // of a user. Authenticates all calls with its own private_key_jwt cert.
  service: {
    clientId: process.env.SERVICE_CLIENT_ID,
    privateKeyFile: process.env.SERVICE_PRIVATE_KEY_FILE,
    kid: process.env.SERVICE_KID,
    // T1 only: SERVICE_ISSUER = the auth server the service app gets its token from
    // (client_credentials); SERVICE_AUDIENCE = the 'audience' param in that T1 call.
    t1TokenUrl: tokenEndpoint(
      process.env.SERVICE_ISSUER || process.env.SERVICE_AUTH_SERVER || AGENT_AUTH_SERVER
    ),
    t1Audience: process.env.SERVICE_AUDIENCE || undefined,
    t1Resource: process.env.SERVICE_RESOURCE || undefined,
    // T2 (token-exchange) endpoint — unchanged, independent of SERVICE_ISSUER.
    tokenUrl: tokenEndpoint(process.env.SERVICE_AUTH_SERVER || AGENT_AUTH_SERVER),
    scopes: process.env.SERVICE_SCOPES || undefined,
    // 'scope' param for the T2 id-JAG token-exchange (omitted if blank).
    idJagScopes: process.env.SERVICE_IDJAG_SCOPES || 'inventory:read',
    // What kind of token the service token is when used as subject_token at T2.
    subjectTokenType:
      process.env.SERVICE_SUBJECT_TOKEN_TYPE || 'urn:ietf:params:oauth:token-type:access_token',
  },

  // STS broker flow (T2) — exchange the user id_token for a brokered resource
  // (e.g. GitHub) token at the org token endpoint. May return interaction_required.
  sts: {
    tokenUrl: ORG_TOKEN_URL,
    revokeUrl: ORG_REVOKE_URL,
    assertionAudience: ORG_TOKEN_URL,
    // 'aud' of the client_assertion for the REVOKE call = the revoke endpoint.
    revokeAssertionAudience: process.env.STS_REVOKE_AUDIENCE || ORG_REVOKE_URL,
    // Revoke path. An RFC 7009 revoke only kills one issued access token — Okta keeps
    // the user's stored GitHub connection, so the next exchange silently mints a new
    // token and consent never re-prompts. This Okta Workflows flow clears the stored
    // connection instead; it takes { id: <Okta user id> }. The URL embeds a clientToken
    // (a bearer-equivalent secret) — override it via STS_REVOKE_WORKFLOW_URL in .env.
    revokeWorkflowUrl:
      process.env.STS_REVOKE_WORKFLOW_URL ||
      'https://oktaforai.workflows.oktapreview.com/api/flo/6c74d30ccce53242a7a08358787032de/invoke?clientToken=a64ae73d11d7d2ff311f8504577e14025b5749c4d03b6df437e34133c78317e7',
    resource: process.env.GITHUB_RESOURCE,
    // Optional 'scope' on the STS token-exchange (omitted if blank). The brokered
    // token's actual scopes are governed by the Okta GitHub Resource Connection.
    scopes: process.env.GITHUB_SCOPES || undefined,
  },

  // T3 of the STS flow — read or create pull requests with the brokered token.
  github: {
    apiBaseUrl: process.env.GITHUB_API_BASE_URL || 'https://api.github.com',
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    // Used by the "create a pull request" action.
    base: process.env.GITHUB_PR_BASE || 'main',
    head: process.env.GITHUB_PR_HEAD,
    title: process.env.GITHUB_PR_TITLE || 'Automated PR via Okta AI Agent',
    body: process.env.GITHUB_PR_BODY || 'Opened by the AI agent using an Okta STS-brokered GitHub token.',
  },

  // Secrets flow (T2) — vaulted-secret token exchange at the org token endpoint.
  secrets: {
    tokenUrl: ORG_TOKEN_URL,
    assertionAudience: ORG_TOKEN_URL,
    resource: process.env.SECRETS_RESOURCE,
  },

  // NHI · Secrets (Atlassian) flow — T1 service client_credentials (config.service), T2 pulls the Atlassian client id/secret from the vault,
  // T3 trades them for an Atlassian token, T4 reads the Scrum board's issues.
  atlassian: {
    tokenUrl: ORG_TOKEN_URL,
    assertionAudience: ORG_TOKEN_URL,
    resource: process.env.ATLASSIAN_SECRETS_RESOURCE,
    // T2 subject is the service app's access token from T1 (client_credentials).
    subjectTokenType: process.env.ATLASSIAN_SUBJECT_TOKEN_TYPE || 'urn:ietf:params:oauth:token-type:access_token',
    oauthTokenUrl: process.env.ATLASSIAN_TOKEN_URL || 'https://api.atlassian.com/oauth/token',
    apiBaseUrl: process.env.ATLASSIAN_API_BASE_URL || 'https://api.atlassian.com',
    audience: process.env.ATLASSIAN_AUDIENCE || 'api.atlassian.com',
    scope: process.env.ATLASSIAN_SCOPE || 'read:board-scope:jira-software read:issue-details:jira',
    cloudId: process.env.ATLASSIAN_CLOUD_ID,
    boardId: process.env.ATLASSIAN_BOARD_ID,
    maxResults: Number(process.env.ATLASSIAN_MAX_RESULTS) || 10,
  },

  // NHI · Secrets (Atlassian token from OPA) — the vaulted secret IS the Atlassian access
  // token, so there is no Atlassian token call. Board/site settings come from `atlassian`.
  atlassianToken: {
    tokenUrl: ORG_TOKEN_URL,
    assertionAudience: ORG_TOKEN_URL,
    resource: process.env.ATLASSIAN_TOKEN_SECRETS_RESOURCE,
    subjectTokenType: process.env.ATLASSIAN_SUBJECT_TOKEN_TYPE || 'urn:ietf:params:oauth:token-type:access_token',
  },

  // Service Account flow (T2) — service-account token exchange at the org token endpoint.
  serviceAccount: {
    tokenUrl: ORG_TOKEN_URL,
    assertionAudience: ORG_TOKEN_URL,
    resource: process.env.SERVICE_ACCOUNT_RESOURCE,
  },

  // T3 of the Secrets / Service Account flows authenticates to the MCP with HTTP
  // Basic. These are the credentials the MCP validates the presented creds against.
  mcpBasic: {
    username: process.env.MCP_BASIC_USERNAME,
    password: process.env.MCP_BASIC_PASSWORD,
  },
};

/**
 * A login app configured for private_key_jwt needs a key + kid; one configured for
 * a client_secret_* method needs the secret. Returns a list of problems.
 */
function loginAuthProblems(label, cfg, keyVar, kidVar, secretVar) {
  if (!cfg.clientId) return []; // app not configured at all (A2A is optional)
  const problems = [];
  if (cfg.tokenAuthMethod === 'private_key_jwt') {
    if (!cfg.privateKeyFile) problems.push(`${label}: set ${keyVar} (or AGENT_PRIVATE_KEY_FILE)`);
    if (!cfg.kid) problems.push(`${label}: set ${kidVar} (or AGENT_KID)`);
  } else if (cfg.tokenAuthMethod.startsWith('client_secret') && !cfg.clientSecret) {
    problems.push(`${label}: ${cfg.tokenAuthMethod} requires ${secretVar}`);
  }
  return problems;
}

export function validateConfig() {
  const missing = REQUIRED.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length) {
    console.error('\n❌ Missing required environment variables:\n');
    missing.forEach((k) => console.error(`   - ${k}`));
    console.error('\nCopy .env.example to .env and fill in your Okta values.\n');
    process.exit(1);
  }

  const problems = [
    ...loginAuthProblems('login app', config.okta, 'OKTA_PRIVATE_KEY_FILE', 'OKTA_KID', 'OKTA_CLIENT_SECRET'),
    ...loginAuthProblems(
      'A2A login app',
      config.a2a.okta,
      'A2A_OKTA_PRIVATE_KEY_FILE',
      'A2A_OKTA_KID',
      'A2A_OKTA_CLIENT_SECRET'
    ),
    ...loginAuthProblems('Web App login app', config.webapp, 'WEBAPP_PRIVATE_KEY_FILE', 'WEBAPP_KID', 'WEBAPP_CLIENT_SECRET'),
  ];
  if (problems.length) {
    console.error('\n❌ Login client authentication is misconfigured:\n');
    problems.forEach((p) => console.error(`   - ${p}`));
    console.error('');
    process.exit(1);
  }
}
