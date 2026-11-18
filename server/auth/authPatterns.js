// Authentication Patterns — login (T0/T1) for the four agents, plus the CIMD
// client metadata document + JWKS this app publishes for the CIMD agent.
//
// "Login as agent": each agent is itself the OIDC client. It redirects the browser to
// /authorize, receives the code at /api/authp/<pattern>/callback and redeems it with
// its own client authentication (private_key_jwt / secret / none / CIMD).
import { Router } from 'express';
import { Issuer, generators } from 'openid-client';
import { config } from '../config.js';
import { privateJwks, publicJwks } from '../util/privateKey.js';
import { buildAuthorizeStep, buildLoginStep, promptParam, captureTokenRequests, takeSentTokenRequest } from './oidc.js';
import { AUTH_PATTERN_IDS, getAgent, agentProblems, signingKid, authNote } from '../xaa/authPatternFlow.js';

const ap = config.authPatterns;
let issuerPromise = null;
const clients = new Map(); // pattern id → openid-client Client

function discover() {
  if (!issuerPromise) {
    issuerPromise = Issuer.discover(ap.issuer).catch((err) => {
      issuerPromise = null; // allow a retry on the next login
      throw err;
    });
  }
  return issuerPromise;
}

/** Build (once) the OIDC client for a pattern, using that pattern's auth method. */
async function getClient(agent) {
  if (clients.has(agent.id)) return clients.get(agent.id);
  const issuer = await discover();
  const metadata = {
    client_id: agent.clientId,
    redirect_uris: [agent.redirectUri],
    response_types: ['code'],
    token_endpoint_auth_method: agent.tokenAuthMethod,
  };
  let client;
  if (agent.tokenAuthMethod === 'private_key_jwt') {
    const kid = await signingKid(agent);
    const jwks = await privateJwks({ privateKeyFile: agent.privateKeyFile, kid });
    client = new issuer.Client({ ...metadata, token_endpoint_auth_signing_alg: 'RS256' }, jwks);
  } else if (agent.tokenAuthMethod.startsWith('client_secret')) {
    client = new issuer.Client({ ...metadata, client_secret: agent.clientSecret });
  } else {
    client = new issuer.Client(metadata); // 'none' — public client, PKCE only
  }
  captureTokenRequests(client);
  clients.set(agent.id, client);
  console.log(`✓ Auth pattern '${agent.id}' OIDC client ready — ${agent.tokenAuthMethod} (client_id: ${agent.clientId})`);
  return client;
}

// openid-client defaults a private_key_jwt assertion's 'aud' to the issuer; Okta wants
// the token endpoint it is posted to (same as every other flow in this app).
const tokenExtras = (agent) =>
  agent.tokenAuthMethod === 'private_key_jwt' ? { clientAssertionPayload: { aud: ap.loginTokenUrl } } : undefined;

const router = Router();

// ── CIMD: the client metadata document. Its URL IS the CIMD agent's client_id. ──
// draft-ietf-oauth-client-id-metadata-document: the AS fetches this to learn the client.
router.get(ap.cimd.metadataPath.replace(/^\/api/, ''), (req, res) => {
  const agent = getAgent('cimd');
  const doc = {
    client_id: agent.clientId,
    client_name: ap.cimd.clientName,
    client_uri: ap.cimd.clientUri,
    // The agent's own login callback plus the Tester's, so the Tester's Fresh login works for CIMD.
    redirect_uris: [...new Set([agent.redirectUri, ...config.tester.redirectUris])],
    response_types: ['code'],
    grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
    token_endpoint_auth_method: agent.tokenAuthMethod,
  };
  if (agent.tokenAuthMethod === 'private_key_jwt') {
    doc.token_endpoint_auth_signing_alg = 'RS256';
    doc.jwks_uri = ap.cimd.jwksUri;
  }
  res.set('Cache-Control', 'public, max-age=300').json(doc);
});

// ── CIMD: public keys for the agent's private_key_jwt assertions. ──
router.get(ap.cimd.jwksPath.replace(/^\/api/, ''), async (req, res) => {
  const agent = getAgent('cimd');
  try {
    const { jwks } = await publicJwks({ privateKeyFile: agent.privateKeyFile, kid: agent.kid });
    res.set('Cache-Control', 'public, max-age=300').json(jwks);
  } catch (err) {
    res.status(500).json({ error: 'jwks_unavailable', error_description: err.message });
  }
});

router.get('/authp/:pattern/login', async (req, res, next) => {
  try {
    const agent = getAgent(req.params.pattern);
    if (!agent) return res.status(404).send('Unknown authentication pattern');
    const problems = agentProblems(agent);
    if (problems.length) return next(new Error(`${agent.label} agent not configured: ${problems.join('; ')}`));

    const client = await getClient(agent);
    const code_verifier = generators.codeVerifier();
    const state = generators.state();
    const nonce = generators.nonce();
    const url = client.authorizationUrl({
      scope: ap.scopes,
      ...promptParam(req),
      code_challenge: generators.codeChallenge(code_verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    req.session.authpPkce = { pattern: agent.id, code_verifier, state, nonce, authorizeUrl: url };
    if (req.query.flow) req.session.pendingFlow = String(req.query.flow);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

router.get('/authp/:pattern/callback', async (req, res) => {
  const agent = getAgent(req.params.pattern);
  try {
    const pkce = req.session.authpPkce;
    if (!agent || !pkce || pkce.pattern !== agent.id) return res.redirect(`${config.appBaseUrl}/?authp=error`);

    const client = await getClient(agent);
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(
      agent.redirectUri,
      params,
      { code_verifier: pkce.code_verifier, state: pkce.state, nonce: pkce.nonce },
      tokenExtras(agent)
    );
    const claims = tokenSet.claims();
    const loginCfg = { ...agent, issuer: ap.issuer };
    req.session.authp = {
      ...(req.session.authp || {}),
      [agent.id]: {
        user: { sub: claims.sub, name: claims.name, email: claims.email },
        idToken: tokenSet.id_token,
        loginStep: [
          { ...buildAuthorizeStep(loginCfg, pkce.authorizeUrl, pkce.state), note: authNote(agent, 'authorize') },
          {
            ...buildLoginStep(tokenSet, loginCfg, {
              tokenUrl: ap.loginTokenUrl,
              title: `Agent Login (${agent.label})`,
              sent: takeSentTokenRequest(params.code),
            }),
            note: authNote(agent, 'token'),
            // Client-secret agent: open HEADERS by default — that's where the secret travels
            // (Authorization: Basic …), so it's the first thing visible on the T1 card.
            ...(agent.id === 'secret' ? { expandHeaders: true } : {}),
          },
        ],
      },
    };
    delete req.session.authpPkce;

    const flow = req.session.pendingFlow;
    delete req.session.pendingFlow;
    res.redirect(`${config.appBaseUrl}/?authp=success${flow ? `&flow=${encodeURIComponent(flow)}` : ''}`);
  } catch (err) {
    console.error(`Auth pattern '${agent?.id}' callback error:`, err);
    res.redirect(`${config.appBaseUrl}/?authp=error`);
  }
});

export { AUTH_PATTERN_IDS };
export default router;
