import { config } from '../config.js';
import { decodeJwt } from '../util/jwt.js';
import { captureFormPost } from './capture.js';
import { mask } from './atlassian.js';
import { requestIdJag, TOKEN_TYPE_ID_TOKEN } from './tokenExchange.js';
import { getAtlassianCredentials } from './atlassianDcr.js';
import { readJiraIssues, createJiraIssue, summarizeJiraIssues } from './stsAtlassian.js';

// HI - Cross-App Access (Atlassian):
//   P0  (one-time) DCR → Atlassian client_id / client_secret   — see atlassianDcr.js
//   T0/T1  user logs in to the agent (regular agent login, private_key_jwt)
//   T2  id_token → id-JAG at the Okta ORG auth server, audience = Atlassian issuer
//   T3  id-JAG → Atlassian access token (jwt-bearer, DCR client credentials)
//   T4+ Atlassian Rovo MCP: initialize → tools/call (read / create Jira issue)

const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

// Check the id-JAG's claims against what Atlassian will expect. Mismatches are reported
// as warnings on the T2 card (Atlassian is the authority — it may still accept it).
function idJagWarnings(claims, creds) {
  const cfg = config.xaaAtlassian;
  const warnings = [];
  if (!claims) return ['The id-JAG is not a decodable JWT.'];
  if (cfg.issuer && claims.aud !== cfg.issuer) {
    warnings.push(`aud is ${JSON.stringify(claims.aud)}, expected the Atlassian issuer ${cfg.issuer}.`);
  }
  // Okta may put either the requesting agent's client_id or the mapped Atlassian (DCR)
  // client_id here, depending on the Cross-App Access resource configuration.
  const known = [creds?.clientId, config.agent.clientId].filter(Boolean);
  if (claims.client_id && !known.includes(claims.client_id)) {
    warnings.push(`client_id is ${claims.client_id} — neither the DCR client_id nor the agent's client_id.`);
  }
  return warnings;
}

/** T3 — present the id-JAG at Atlassian's token endpoint with the DCR client credentials. */
export async function redeemIdJagAtAtlassian(idJag, creds) {
  const cfg = config.xaaAtlassian;
  const bodyParams = {
    grant_type: GRANT_JWT_BEARER,
    assertion: idJag,
    client_id: creds.clientId,
    ...(creds.clientSecret ? { client_secret: creds.clientSecret } : {}),
    requested_token_type: TOKEN_TYPE_ACCESS_TOKEN,
  };

  const { captured, responseBody, ok } = await captureFormPost(
    {
      id: 'T3',
      title: 'Access Token Request (Atlassian)',
      badge: 'Access Token',
      from: 'Agent',
      to: 'Atlassian Auth Server',
      tokenField: 'access_token',
    },
    cfg.tokenUrl,
    { Accept: 'application/json' },
    bodyParams
  );

  // Never show the DCR client secret in the UI.
  if (creds.clientSecret) {
    const shown = mask(creds.clientSecret);
    for (const raw of [creds.clientSecret, encodeURIComponent(creds.clientSecret)]) {
      captured.request.body = captured.request.body.split(raw).join(shown);
      captured.code = captured.code.split(raw).join(shown);
    }
  }
  const traceId = captured.response.headers?.['atl-traceid'];
  captured.note =
    `client_id / client_secret are the agent’s Atlassian credentials from the one-time DCR registration (P0, source: ${creds.source}).` +
    (traceId ? ` Atlassian trace ID: ${traceId}.` : '');

  return { step: captured, accessToken: ok ? responseBody.access_token : null, ok };
}

/** The whole chain after login. Returns the chat answer string. */
export async function runXaaAtlassianFlow(idToken, steps, action) {
  const cfg = config.xaaAtlassian;
  if (!cfg.issuer) {
    return 'HI - Cross-App Access (Atlassian) is not configured — set ATLASSIAN_XAA_ISSUER in .env.';
  }
  const creds = getAtlassianCredentials();
  if (!creds) {
    return 'The agent is not registered with Atlassian yet — open “Prerequisite · Dynamic Client Registration” above the steps and click Register (or set ATLASSIAN_XAA_CLIENT_ID / ATLASSIAN_XAA_CLIENT_SECRET).';
  }

  // T2 — every override is explicit so the plain Cross-App Access config (XAA_RESOURCE,
  // XAA_SCOPES, RESOURCE_AUDIENCE) never leaks into this flow. '' = omit the param.
  const t2 = await requestIdJag(idToken, TOKEN_TYPE_ID_TOKEN, {
    tokenUrl: cfg.idJagTokenUrl,
    assertionAudience: cfg.idJagTokenUrl,
    audience: cfg.audience,
    scope: cfg.scopes,
    resource: cfg.resource || '',
  });
  t2.step.title = 'Token Exchange → ID-JAG (for Atlassian)';
  steps.push(t2.step);
  if (!t2.ok) return 'The token exchange (id-JAG) request failed — see step T2 for the error response.';

  const claims = decodeJwt(t2.idJag)?.payload;
  const warnings = idJagWarnings(claims, creds);
  t2.step.note = warnings.length
    ? `⚠ id-JAG claim check: ${warnings.join(' ')}`
    : `id-JAG claim check passed: aud = Atlassian issuer, client_id = ${claims.client_id}${claims.aud_tenant ? `, aud_tenant = ${claims.aud_tenant}` : ''}.`;

  const t3 = await redeemIdJagAtAtlassian(t2.idJag, creds);
  steps.push(t3.step);
  if (!t3.ok) return 'Atlassian rejected the id-JAG redemption — see step T3 for the error response.';

  const jiraOpts = {
    mcpUrl: cfg.mcpUrl,
    // The Jira site must be one the app is installed on. aud_tenant is whatever tenant id
    // the Okta Atlassian resource is configured with (often the Atlassian org, not the
    // site), so discover the token's sites first and only fall back to aud_tenant.
    cloudId: cfg.cloudId,
    fallbackCloudId: claims?.aud_tenant,
    projectKey: cfg.projectKey,
    issueType: cfg.issueType,
    summary: cfg.summary,
    description: cfg.description,
    maxResults: cfg.maxResults,
    firstStep: 4,
    envPrefix: 'ATLASSIAN_XAA',
    mcpUrlVar: 'ATLASSIAN_XAA_MCP_URL',
  };

  if (action === 'create') {
    const r = await createJiraIssue(t3.accessToken, steps, jiraOpts);
    if (!r.ok) return `${r.error} — see the Atlassian MCP steps.`;
    const { issue } = r;
    const lines = [
      `Jira ticket created${issue.key ? `: ${issue.key}` : ''}`,
      '',
      `• Project: ${issue.projectKey}`,
      `• Type: ${issue.issueType}`,
      `• Summary: ${issue.summary}`,
      `• Description: ${issue.description}`,
      issue.browseUrl ? `• Link: ${issue.browseUrl}` : null,
    ].filter((l) => l !== null);
    if (!issue.key) lines.push('', 'The ticket key was not in the response — see the last MCP step.');
    return lines.join('\n');
  }

  const r = await readJiraIssues(t3.accessToken, steps, jiraOpts);
  if (!r.ok) return `${r.error} — see the Atlassian MCP steps.`;
  return summarizeJiraIssues(r.issues, r.projectKey, r.raw);
}
