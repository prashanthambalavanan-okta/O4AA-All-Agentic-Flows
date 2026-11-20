import { config } from '../config.js';
import { decodeJwt } from '../util/jwt.js';
import { captureFormPost, captureGet, captureJsonPost } from './capture.js';
import { requestIdJag, exchangeForAccessToken, TOKEN_TYPE_ID_TOKEN, TOKEN_TYPE_ACCESS_TOKEN } from './tokenExchange.js';

// HI - Cross-App Access (Google Cloud via Workload Identity Federation)
//
// Google does not accept Okta id-JAGs, so the standard XAA chain ends at an Okta Custom
// Authorization Server whose Audience IS the Google workload identity provider. Google
// STS trusts that Custom AS as an OIDC issuer and swaps its token for a federated token.
//
//   T0/T1  user logs in to the agent (regular agent login, private_key_jwt)
//   T2     id_token → id-JAG at the Okta ORG auth server (audience = Custom AS)
//   T3     id-JAG → Okta access token at the Custom AS (jwt-bearer; aud = WIF provider)
//   T4     Okta access token → Google federated access token (Google STS token-exchange)
//   T5     BigQuery jobs.query                                     (action 'bigquery')
//   T5..T7 Workspace: impersonate a service account, then Drive files.list (action 'workspace')

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// The Google-side fields this flow cannot run without. Returns a chat message, or null.
function missingConfig(action) {
  const g = config.googleWif;
  const missing = [];
  if (!g.authServer) missing.push('GCP_XAA_AUTH_SERVER');
  if (!g.wifAudience) missing.push('GCP_PROJECT_NUMBER + GCP_WIF_POOL_ID + GCP_WIF_PROVIDER_ID (or GCP_WIF_AUDIENCE)');
  if (action === 'bigquery' && !g.projectId) missing.push('GCP_PROJECT_ID');
  if (action === 'workspace' && !g.workspaceServiceAccount) missing.push('GCP_WORKSPACE_SA_EMAIL');
  return missing.length
    ? `HI - Cross-App Access (Google Cloud) is not configured — set ${missing.join(', ')} in .env.`
    : null;
}

// T3 claim check — what Google STS / the pool's attribute mapping will look at.
function oktaTokenNote(claims) {
  const g = config.googleWif;
  if (!claims) return '⚠ The Okta access token is not a decodable JWT — Google STS needs an RS256/ES256 JWT.';
  const warnings = [];
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(g.wifAudience)) {
    warnings.push(`aud is ${JSON.stringify(claims.aud)} — set the Custom AS Audience to ${g.wifAudience} or Google STS will reject it.`);
  }
  if (claims.iss !== g.authServer) warnings.push(`iss is ${claims.iss}; the WIF provider's --issuer-uri must equal it exactly.`);
  if (!claims.sub) warnings.push('no sub claim — google.subject=assertion.sub would fail.');
  else if (String(claims.sub).length > 127) warnings.push('sub is longer than 127 characters — Google rejects it as google.subject.');
  if (claims.exp && claims.iat && claims.exp - claims.iat > 86400) warnings.push('exp - iat exceeds 24h — Google rejects it.');
  if (!claims.act) warnings.push('no act claim — map the agent from cid instead of assertion.act.sub.');

  const mapped = [
    `google.subject = ${claims.sub}`,
    claims.act?.sub ? `attribute.agent = ${claims.act.sub}` : null,
    claims.cid ? `attribute.client = ${claims.cid}` : null,
    claims.scp ? `scp = ${[].concat(claims.scp).join(' ')}` : null,
  ].filter(Boolean);
  return (warnings.length ? `⚠ ${warnings.join(' ')} ` : 'Claim check passed. ') + `What Google will map: ${mapped.join(', ')}.`;
}

/** T4 — Google STS: Okta access token (subject) → federated access token. No client auth. */
export async function exchangeAtGoogleSts(oktaAccessToken, ov = {}) {
  const g = config.googleWif;
  const audience = ov.audience ?? g.wifAudience;
  const { captured, responseBody, ok } = await captureFormPost(
    {
      id: ov.id || 'T4',
      title: 'Google STS Token Exchange → Federated Token',
      badge: 'Google Token',
      from: 'Agent',
      to: 'Google STS',
      tokenField: null, // the federated token is opaque, not a JWT
    },
    ov.stsUrl ?? g.stsUrl,
    { Accept: 'application/json' },
    {
      grant_type: GRANT_TOKEN_EXCHANGE,
      audience,
      subject_token: oktaAccessToken,
      subject_token_type: TOKEN_TYPE_JWT,
      requested_token_type: TOKEN_TYPE_ACCESS_TOKEN,
      scope: ov.scope ?? g.stsScope,
    }
  );
  const claims = decodeJwt(oktaAccessToken)?.payload;
  captured.note = ok
    ? `Federated token for principal://iam.googleapis.com/projects/${g.projectNumber || '<n>'}/locations/global/workloadIdentityPools/${g.poolId || '<pool>'}/subject/${claims?.sub ?? '<sub>'} — expires_in ${responseBody?.expires_in ?? '?'}s (Okta token expires in ${claims?.exp ? claims.exp - Math.floor(Date.now() / 1000) : '?'}s). No client credentials: Google trusts the Okta Custom AS signature (JWKS), audience, expiry and the pool's attribute condition.`
    : 'Google STS rejected the Okta token. Common causes: issuer-uri ≠ the Custom AS issuer, the Custom AS Audience ≠ the provider audience, or the attribute condition (agent allow-list / required scope) is false.';
  return { step: captured, federatedToken: ok ? responseBody.access_token : null, ok };
}

// ── BigQuery ──

function summarizeBigQuery(body) {
  const g = config.googleWif;
  if (body?.jobComplete === false) {
    return `The BigQuery job (${body.jobReference?.jobId}) did not finish within the request timeout — see step T5.`;
  }
  const fields = (body?.schema?.fields || []).map((f) => f.name);
  const rows = (body?.rows || []).map((r) => (r.f || []).map((c) => (c.v === null ? 'NULL' : String(c.v))));
  const lines = [`BigQuery returned ${body?.totalRows ?? rows.length} row(s) from project ${g.projectId}:`, ''];
  if (fields.length) lines.push(fields.join(' | '), fields.map(() => '---').join(' | '));
  for (const r of rows.slice(0, g.maxResults)) lines.push(r.join(' | '));
  lines.push('', 'The query ran as the federated principal — Google IAM (and any BigQuery row/column policies) authorized the signed-in user, not a service account key.');
  return lines.join('\n');
}

export async function queryBigQuery(federatedToken, steps, ov = {}) {
  const g = config.googleWif;
  const projectId = ov.projectId ?? g.projectId;
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries`;
  const body = {
    query: ov.query ?? g.bigqueryQuery,
    useLegacySql: false,
    maxResults: g.maxResults,
    ...(g.bigqueryLocation ? { location: g.bigqueryLocation } : {}),
  };
  const { captured, responseBody, ok } = await captureJsonPost(
    { id: ov.id || 'T5', title: 'BigQuery · jobs.query', badge: 'Google API', from: 'Agent', to: 'BigQuery API' },
    url,
    bearer(federatedToken),
    body
  );
  if (!ok) {
    captured.note =
      'A 403 here usually means the federated principal lacks roles/bigquery.jobUser on the project (or dataViewer on the dataset). Grant it to principal://…/subject/<sub> or principalSet://…/attribute.agent/<agent>.';
  }
  steps.push(captured);
  return ok ? { ok, answer: summarizeBigQuery(responseBody) } : { ok, answer: 'BigQuery rejected the call — see step T5.' };
}

// ── Google Workspace (Drive) via service-account impersonation ──

const iamUrl = (sa, method) =>
  `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:${method}`;

/** Domain-wide delegation: signJwt(sub = user) → Google OAuth jwt-bearer → token AS the user. */
async function workspaceTokenViaDwd(federatedToken, subjectEmail, steps, n) {
  const g = config.googleWif;
  const sa = g.workspaceServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa,
    sub: subjectEmail,
    scope: g.workspaceScopes,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: now,
    exp: now + 600,
  };
  const sign = await captureJsonPost(
    { id: `T${n}`, title: 'IAM Credentials · signJwt (impersonate SA)', badge: 'Signed JWT', from: 'Agent', to: 'IAM Credentials API' },
    iamUrl(sa, 'signJwt'),
    bearer(federatedToken),
    { payload: JSON.stringify(payload) }
  );
  sign.captured.note = sign.ok
    ? `The federated principal had the service account ${sa} sign a domain-wide-delegation assertion with sub = ${subjectEmail}. Requires roles/iam.serviceAccountTokenCreator on the SA for the federated principal.`
    : 'signJwt failed — grant the federated principal roles/iam.serviceAccountTokenCreator on the service account, and enable the IAM Service Account Credentials API.';
  steps.push(sign.captured);
  if (!sign.ok) return { ok: false, error: `signJwt failed — see step T${n}.` };

  const tok = await captureFormPost(
    { id: `T${n + 1}`, title: 'Google OAuth · jwt-bearer (as the user)', badge: 'Workspace Token', from: 'Agent', to: 'Google OAuth', tokenField: null },
    GOOGLE_OAUTH_TOKEN_URL,
    { Accept: 'application/json' },
    { grant_type: GRANT_JWT_BEARER, assertion: sign.responseBody.signedJwt }
  );
  tok.captured.note = tok.ok
    ? `Workspace access token for ${subjectEmail}, limited to: ${g.workspaceScopes}.`
    : 'Google rejected the DWD assertion — in the Workspace Admin console (Security › API controls › Domain-wide delegation) authorize the SA’s OAuth client ID for these scopes, and make sure the subject is a Workspace user.';
  steps.push(tok.captured);
  if (!tok.ok) return { ok: false, error: `The domain-wide delegation token request failed — see step T${n + 1}.` };
  return { ok: true, token: tok.responseBody.access_token, next: n + 2, actingAs: subjectEmail };
}

/** Shared files: generateAccessToken → token as the SA itself. */
async function workspaceTokenViaSa(federatedToken, steps, n) {
  const g = config.googleWif;
  const sa = g.workspaceServiceAccount;
  const r = await captureJsonPost(
    { id: `T${n}`, title: 'IAM Credentials · generateAccessToken (impersonate SA)', badge: 'SA Token', from: 'Agent', to: 'IAM Credentials API' },
    iamUrl(sa, 'generateAccessToken'),
    bearer(federatedToken),
    { scope: g.workspaceScopes.split(/\s+/).filter(Boolean), lifetime: '3600s' }
  );
  r.captured.note = r.ok
    ? `Token for ${sa}. It only sees Drive files shared with the service account.`
    : 'generateAccessToken failed — grant the federated principal roles/iam.workloadIdentityUser (or serviceAccountTokenCreator) on the service account.';
  steps.push(r.captured);
  if (!r.ok) return { ok: false, error: `Service account impersonation failed — see step T${n}.` };
  return { ok: true, token: r.responseBody.accessToken, next: n + 1, actingAs: sa };
}

/** mode: 'dwd' = act as the user (domain-wide delegation) · 'shared' = act as the SA itself. */
export async function listDriveFiles(federatedToken, subjectEmail, steps, firstStep = 5, mode = 'dwd') {
  const g = config.googleWif;
  const dwd = mode !== 'shared';
  if (dwd && !subjectEmail) {
    return { ok: false, answer: 'No email claim on the id_token to impersonate — set GCP_WORKSPACE_SUBJECT or add the email scope.' };
  }
  const t = dwd
    ? await workspaceTokenViaDwd(federatedToken, subjectEmail, steps, firstStep)
    : await workspaceTokenViaSa(federatedToken, steps, firstStep);
  if (!t.ok) return { ok: false, answer: t.error };

  const qs = new URLSearchParams({
    pageSize: String(g.drivePageSize),
    q: g.driveQuery,
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });
  const url = `https://www.googleapis.com/drive/v3/files?${qs}`;
  const r = await captureGet(
    { id: `T${t.next}`, title: 'Google Drive · files.list', badge: 'Google API', from: 'Agent', to: 'Google Drive API' },
    url,
    bearer(t.token)
  );
  r.captured.code = `curl '${url}' \\\n  -H 'Authorization: ${r.captured.request.headers.Authorization}'`;
  steps.push(r.captured);
  if (!r.ok) return { ok: false, answer: `Drive rejected the call — see step T${t.next}.` };

  const files = r.responseBody?.files || [];
  const lines = [`${files.length} Drive file(s) visible to ${t.actingAs}:`, ''];
  for (const f of files) {
    lines.push(`• ${f.name} — ${f.mimeType?.replace('application/vnd.google-apps.', '')}, modified ${f.modifiedTime}${f.webViewLink ? `\n  ${f.webViewLink}` : ''}`);
  }
  if (!files.length) lines.push(dwd ? '(The user has no matching files.)' : '(Nothing is shared with the service account yet.)');
  return { ok: true, answer: lines.join('\n') };
}

/** The whole chain after login. Returns the chat answer string. */
export async function runGoogleWifFlow(idToken, steps, action = 'bigquery', { workspaceMode = 'dwd' } = {}) {
  const g = config.googleWif;
  const notConfigured = missingConfig(action);
  if (notConfigured) return notConfigured;

  // T2 — explicit overrides so the plain XAA config (XAA_RESOURCE, RESOURCE_AUDIENCE…)
  // never leaks in. '' = omit the param.
  const t2 = await requestIdJag(idToken, TOKEN_TYPE_ID_TOKEN, {
    tokenUrl: g.idJagTokenUrl,
    assertionAudience: g.idJagTokenUrl,
    audience: g.idJagAudience,
    scope: g.scopes,
    resource: g.resource || '',
  });
  t2.step.title = 'Token Exchange → ID-JAG (for the Google Custom AS)';
  t2.step.to = 'Okta Org Server';
  steps.push(t2.step);
  if (!t2.ok) return 'The token exchange (id-JAG) request failed — see step T2 for the error response.';

  // T3 — jwt-bearer at the dedicated Custom AS, as the agent client.
  const t3 = await exchangeForAccessToken(t2.idJag, config.agent.clientId, {
    tokenUrl: g.tokenUrl,
    assertionAudience: g.tokenUrl,
  });
  t3.step.title = 'Access Token Request (Custom AS · aud = Google)';
  t3.step.to = 'Okta Custom AS';
  steps.push(t3.step);
  if (!t3.ok) return 'The Custom AS rejected the id-JAG — see step T3 (check the access policy has a JWT Bearer rule for the agent).';
  const oktaClaims = decodeJwt(t3.accessToken)?.payload;
  t3.step.note = oktaTokenNote(oktaClaims);

  const t4 = await exchangeAtGoogleSts(t3.accessToken);
  steps.push(t4.step);
  if (!t4.ok) return 'Google STS rejected the Okta access token — see step T4.';

  if (action === 'workspace') {
    const email = g.workspaceSubject || decodeJwt(idToken)?.payload?.email;
    const r = await listDriveFiles(t4.federatedToken, email, steps, 5, workspaceMode);
    if (r.ok && email && oktaClaims?.sub && oktaClaims.sub !== email && workspaceMode !== 'shared') {
      return `${r.answer}\n\n⚠ The impersonated Workspace user (${email}) differs from the Okta token's sub (${oktaClaims.sub}) — make sure they are the same person.`;
    }
    return r.answer;
  }

  const r = await queryBigQuery(t4.federatedToken, steps);
  return r.answer;
}
