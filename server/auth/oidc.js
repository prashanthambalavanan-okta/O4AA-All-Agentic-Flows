import { Router } from 'express';
import { Issuer, generators } from 'openid-client';
import { config } from '../config.js';
import { decodeJwt } from '../util/jwt.js';
import { privateJwks } from '../util/privateKey.js';

let client = null; // regular login (.env OKTA_*)
let a2aClient = null; // A2A login (.env.a2a A2A_OKTA_*)
let webappClient = null; // Web App login (.env WEBAPP_*)

const usesPrivateKeyJwt = (oktaCfg) => oktaCfg.tokenAuthMethod === 'private_key_jwt';

/**
 * Build an OIDC client for a login app. With private_key_jwt there is no client
 * secret anywhere: the client proves its identity at /token with a short-lived JWT
 * signed by the app's private key (RFC 7523 §2.2), and Okta verifies it against the
 * public JWK registered on the app.
 */
async function buildLoginClient(oktaCfg, label) {
  const issuer = await Issuer.discover(oktaCfg.issuer);

  if (!usesPrivateKeyJwt(oktaCfg)) {
    const c = new issuer.Client({
      client_id: oktaCfg.clientId,
      client_secret: oktaCfg.clientSecret,
      redirect_uris: [oktaCfg.redirectUri],
      response_types: ['code'],
      token_endpoint_auth_method: oktaCfg.tokenAuthMethod,
    });
    console.log(`✓ ${label} ready — ${oktaCfg.tokenAuthMethod} (issuer: ${issuer.metadata.issuer})`);
    return c;
  }

  // openid-client signs the assertion with this JWKS and copies its kid into the
  // JWS header, so the kid must be the one registered on the app in Okta.
  const jwks = await privateJwks({ privateKeyFile: oktaCfg.privateKeyFile, kid: oktaCfg.kid });
  const c = new issuer.Client(
    {
      client_id: oktaCfg.clientId,
      redirect_uris: [oktaCfg.redirectUri],
      response_types: ['code'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'RS256',
    },
    jwks
  );
  console.log(
    `✓ ${label} ready — private_key_jwt (issuer: ${issuer.metadata.issuer}, key: ${oktaCfg.privateKeyFile}, kid: ${oktaCfg.kid})`
  );
  return c;
}

/**
 * Extras for the token request. openid-client defaults the assertion's 'aud' to the
 * issuer identifier; Okta expects the token endpoint it is sent to, which is also
 * what every other flow in this app uses.
 */
function tokenExtras(oktaCfg) {
  if (!usesPrivateKeyJwt(oktaCfg)) return undefined;
  return { clientAssertionPayload: { aud: oktaCfg.assertionAudience } };
}

/** Discover the Okta issuer(s) and build the OIDC client(s) once at startup. */
export async function initOidc() {
  client = await buildLoginClient(config.okta, 'OIDC client');

  // A2A is optional: without .env.a2a filled in there is nothing to discover. A failure
  // here (unreachable issuer, wrong auth server id) only disables the A2A flows, so warn
  // and carry on instead of taking the whole server down with it.
  if (!config.a2a.okta.issuer || !config.a2a.okta.clientId) {
    console.log('• A2A OIDC client skipped — A2A_OKTA_ISSUER / A2A_OKTA_CLIENT_ID not set in .env.a2a');
  } else {
    try {
      a2aClient = await buildLoginClient(config.a2a.okta, 'A2A OIDC client');
    } catch (err) {
      console.warn(
        `⚠ A2A OIDC client unavailable — A2A flows disabled (${config.a2a.okta.issuer}): ${err.message}`
      );
    }
  }

  // Web App login is optional too: without WEBAPP_CLIENT_ID/SECRET there's nothing
  // to discover, so just disable the 'xaa-webapp' flow and carry on.
  if (!config.webapp.clientId) {
    console.log('• Web App OIDC client skipped — WEBAPP_CLIENT_ID not set in .env');
    return;
  }
  try {
    webappClient = await buildLoginClient(config.webapp, 'Web App OIDC client');
  } catch (err) {
    console.warn(
      `⚠ Web App OIDC client unavailable — xaa-webapp flow disabled (${config.webapp.issuer}): ${err.message}`
    );
  }
}

/**
 * Build the synthesized T0 "Authorization Request" step. /authorize is a full-page
 * browser redirect, not a fetch this server awaits — so unlike the other captured
 * steps, the "response" here is reconstructed: the 302 Okta sends back to
 * `redirect_uri` once the user authenticates, carrying the code we later exchange at T1.
 */
function buildAuthorizeStep(oktaCfg, authorizeUrl, state) {
  const location = `${oktaCfg.redirectUri}?code=<authorization_code>&state=${state}`;
  return {
    id: 'T0',
    title: 'Authorization Request',
    badge: 'Authorization Code',
    from: 'User',
    to: 'IdP',
    ok: true,
    request: {
      method: 'GET',
      url: authorizeUrl,
      headers: {},
      body: '',
    },
    response: {
      status: 302,
      headers: { Location: location },
      body: '',
    },
    token: null,
    code: `curl -i '${authorizeUrl}'\n\n# Browser authenticates at the IdP, then:\nHTTP/1.1 302 Found\nLocation: ${location}`,
  };
}

/**
 * Build the captured T1 "User Login" step from the token set. `oktaCfg` selects the
 * regular or A2A app's issuer/client.
 */
function buildLoginStep(tokenSet, oktaCfg) {
  const tokenUrl = `${oktaCfg.issuer.replace(/\/$/, '')}/v1/token`;
  // Show how the web app authenticated itself: a signed client assertion (no secret)
  // or, if it's still on the legacy method, its client secret.
  const clientAuth = usesPrivateKeyJwt(oktaCfg)
    ? [
        'client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        'client_assertion=<signed_jwt>',
      ]
    : ['client_secret=<client_secret>'];
  return {
    id: 'T1',
    title: 'User Login',
    badge: 'Access Token',
    from: 'User',
    to: 'IdP',
    ok: true,
    request: {
      method: 'POST',
      url: tokenUrl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: [
        'grant_type=authorization_code',
        'code=<authorization_code>',
        `client_id=${oktaCfg.clientId}`,
        `redirect_uri=${oktaCfg.redirectUri}`,
        'code_verifier=<pkce_verifier>',
        ...clientAuth,
      ].join('&'),
    },
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        token_type: tokenSet.token_type,
        expires_in: tokenSet.expires_in,
        scope: tokenSet.scope,
        access_token: tokenSet.access_token,
        id_token: tokenSet.id_token,
      },
    },
    token: decodeJwt(tokenSet.access_token) || decodeJwt(tokenSet.id_token),
    code: `curl -X POST '${tokenUrl}' \\\n  -H 'Content-Type: application/x-www-form-urlencoded' \\\n  -d 'grant_type=authorization_code&code=<code>&redirect_uri=${oktaCfg.redirectUri}&code_verifier=<verifier>' \\\n  -d '${clientAuth.join("' \\\n  -d '")}'`,
  };
}

const router = Router();

// ── Regular login (.env) ──
router.get('/login', (req, res, next) => {
  if (!client) return next(new Error('OIDC not initialized'));
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.pkce = { code_verifier, state, nonce };
  if (req.query.flow) req.session.pendingFlow = String(req.query.flow);

  const url = client.authorizationUrl({
    scope: config.okta.scopes,
    code_challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  req.session.pkce.authorizeUrl = url;
  res.redirect(url);
});

router.get('/callback', async (req, res, next) => {
  try {
    if (!client) return next(new Error('OIDC not initialized'));
    const { pkce } = req.session;
    if (!pkce) return res.redirect(`${config.appBaseUrl}/?auth=error`);

    const params = client.callbackParams(req);
    const tokenSet = await client.callback(
      config.okta.redirectUri,
      params,
      {
        code_verifier: pkce.code_verifier,
        state: pkce.state,
        nonce: pkce.nonce,
      },
      tokenExtras(config.okta)
    );

    const claims = tokenSet.claims();
    req.session.user = { sub: claims.sub, name: claims.name, email: claims.email };
    req.session.idToken = tokenSet.id_token;
    // Kept for the STS revoke path, which reads the `uid` claim out of the access token.
    req.session.accessToken = tokenSet.access_token;
    req.session.loginStep = [
      buildAuthorizeStep(config.okta, pkce.authorizeUrl, pkce.state),
      buildLoginStep(tokenSet, config.okta),
    ];
    delete req.session.pkce;

    const flow = req.session.pendingFlow;
    delete req.session.pendingFlow;
    res.redirect(`${config.appBaseUrl}/?auth=success${flow ? `&flow=${encodeURIComponent(flow)}` : ''}`);
  } catch (err) {
    console.error('OIDC callback error:', err);
    res.redirect(`${config.appBaseUrl}/?auth=error`);
  }
});

// ── A2A login (.env.a2a) — its own client; /authorize includes the Inventory resource ──
router.get('/a2a/login', (req, res, next) => {
  if (!a2aClient) return next(new Error('A2A OIDC not configured (set A2A_OKTA_* in .env.a2a)'));
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.a2aPkce = { code_verifier, state, nonce };
  if (req.query.flow) req.session.pendingFlow = String(req.query.flow);

  const authParams = {
    scope: config.a2a.okta.scopes,
    code_challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  };
  if (config.a2a.inventoryAgent.resource) authParams.resource = config.a2a.inventoryAgent.resource;

  const url = a2aClient.authorizationUrl(authParams);
  req.session.a2aPkce.authorizeUrl = url;
  res.redirect(url);
});

router.get('/a2a/callback', async (req, res, next) => {
  try {
    if (!a2aClient) return next(new Error('A2A OIDC not configured'));
    const { a2aPkce } = req.session;
    if (!a2aPkce) return res.redirect(`${config.appBaseUrl}/?a2a=error`);

    const params = a2aClient.callbackParams(req);
    const tokenSet = await a2aClient.callback(
      config.a2a.okta.redirectUri,
      params,
      {
        code_verifier: a2aPkce.code_verifier,
        state: a2aPkce.state,
        nonce: a2aPkce.nonce,
      },
      tokenExtras(config.a2a.okta)
    );

    const claims = tokenSet.claims();
    req.session.a2aUser = { sub: claims.sub, name: claims.name, email: claims.email };
    req.session.a2aIdToken = tokenSet.id_token;
    req.session.a2aAccessToken = tokenSet.access_token;
    req.session.a2aLoginStep = [
      buildAuthorizeStep(config.a2a.okta, a2aPkce.authorizeUrl, a2aPkce.state),
      buildLoginStep(tokenSet, config.a2a.okta),
    ];
    delete req.session.a2aPkce;

    const flow = req.session.pendingFlow;
    delete req.session.pendingFlow;
    res.redirect(`${config.appBaseUrl}/?a2a=success${flow ? `&flow=${encodeURIComponent(flow)}` : ''}`);
  } catch (err) {
    console.error('A2A OIDC callback error:', err);
    res.redirect(`${config.appBaseUrl}/?a2a=error`);
  }
});

// ── Web App login (.env WEBAPP_*) — own client, client_secret auth; /authorize
// carries the 'resource' param. Its ACCESS token (not id_token) is the T2 subject. ──
router.get('/webapp/login', (req, res, next) => {
  if (!webappClient) return next(new Error('Web App OIDC not configured (set WEBAPP_* in .env)'));
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.webappPkce = { code_verifier, state, nonce };
  if (req.query.flow) req.session.pendingFlow = String(req.query.flow);

  const authParams = {
    scope: config.webapp.scopes,
    code_challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  };
  if (config.webapp.resource) authParams.resource = config.webapp.resource;

  const url = webappClient.authorizationUrl(authParams);
  req.session.webappPkce.authorizeUrl = url;
  res.redirect(url);
});

router.get('/webapp/callback', async (req, res, next) => {
  try {
    if (!webappClient) return next(new Error('Web App OIDC not configured'));
    const { webappPkce } = req.session;
    if (!webappPkce) return res.redirect(`${config.appBaseUrl}/?webapp=error`);

    const params = webappClient.callbackParams(req);
    const tokenSet = await webappClient.callback(
      config.webapp.redirectUri,
      params,
      {
        code_verifier: webappPkce.code_verifier,
        state: webappPkce.state,
        nonce: webappPkce.nonce,
      },
      tokenExtras(config.webapp)
    );

    const claims = tokenSet.claims();
    req.session.webappUser = { sub: claims.sub, name: claims.name, email: claims.email };
    req.session.webappAccessToken = tokenSet.access_token;
    req.session.webappLoginStep = [
      buildAuthorizeStep(config.webapp, webappPkce.authorizeUrl, webappPkce.state),
      buildLoginStep(tokenSet, config.webapp),
    ];
    delete req.session.webappPkce;

    const flow = req.session.pendingFlow;
    delete req.session.pendingFlow;
    res.redirect(`${config.appBaseUrl}/?webapp=success${flow ? `&flow=${encodeURIComponent(flow)}` : ''}`);
  } catch (err) {
    console.error('Web App OIDC callback error:', err);
    res.redirect(`${config.appBaseUrl}/?webapp=error`);
  }
});

router.get('/me', (req, res) => {
  res.json({
    authenticated: !!req.session.user,
    user: req.session.user || null,
    loginStep: req.session.loginStep || null,
    a2aAuthenticated: !!req.session.a2aUser,
    a2aUser: req.session.a2aUser || null,
    a2aLoginStep: req.session.a2aLoginStep || null,
    samlAuthenticated: !!req.session.samlAssertion,
    samlUser: req.session.samlUser || null,
    samlLoginStep: req.session.samlLoginStep || null,
    webappAuthenticated: !!req.session.webappAccessToken,
    webappUser: req.session.webappUser || null,
    webappLoginStep: req.session.webappLoginStep || null,
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

export default router;
