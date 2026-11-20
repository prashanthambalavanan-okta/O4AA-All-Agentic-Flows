// Tester tab API — run any flow one step at a time with operator-supplied values.
//
//   GET  /api/tester/flows/:flow       the flow's steps + .env defaults (no secrets)
//   POST /api/tester/run               { flow, stepId, values } → { ok, steps, outputs, message?, redirect? }
//   GET  /api/tester/callback          redirect target for the Tester's own fresh login
//   GET  /api/tester/login-result      the fresh-login result for a flow (read once)
//
// The browser holds the chain state (each step's outputs) and posts the bound values
// back with the next step, so nothing here is stateful except the in-flight login.
import crypto from 'crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { buildAuthorizeStep } from '../auth/oidc.js';
import { flowSteps, publicSteps } from '../tester/catalog.js';
import { runStep, TOKEN_TYPES } from '../tester/steps.js';
import { resolveAuth, tokenPost, failedStep } from '../tester/clientAuth.js';

const router = Router();

function gate(req, res, next) {
  if (!config.tester.enabled) {
    return res.status(403).json({ error: 'tester_disabled', error_description: 'The Tester is disabled — set TESTER_ENABLED=true to enable it.' });
  }
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

const b64url = (buf) => buf.toString('base64url');

// Authorization + token endpoints for an issuer: discovery first, Okta's URL shape as a fallback.
async function endpoints(issuer) {
  const base = String(issuer || '').trim().replace(/\/$/, '');
  if (!base) throw new Error('Issuer is required for a fresh login.');
  try {
    const res = await fetch(`${base}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const md = await res.json();
      if (md.authorization_endpoint && md.token_endpoint) return { authorize: md.authorization_endpoint, token: md.token_endpoint };
    }
  } catch {
    /* fall through to the Okta URL shape */
  }
  const prefix = base.includes('/oauth2') ? base : `${base}/oauth2`;
  return { authorize: `${prefix}/v1/authorize`, token: `${prefix}/v1/token` };
}

// The Okta apps the Tester's "Fresh login" can log in with by default — each needs the
// Tester callback URIs as sign-in redirect URIs. Client ids are public identifiers.
const DEFAULT_FLOWS = ['xaa', 'secrets', 'service-account', 'sts-github', 'sts-atlassian', 'xaa-atlassian', 'xaa-gcp'];
function loginApps(currentFlow) {
  const ap = config.authPatterns.agents;
  const apps = [
    { label: 'Agent login app', env: 'OKTA_CLIENT_ID', clientId: config.okta.clientId, flows: DEFAULT_FLOWS },
    { label: 'Web App', env: 'WEBAPP_CLIENT_ID', clientId: config.webapp.clientId, flows: ['xaa-webapp'] },
    { label: 'A2A login app', env: 'A2A_OKTA_CLIENT_ID', clientId: config.a2a.okta.clientId, flows: ['hi-a2a'] },
    ...Object.values(ap).map((a) => ({
      label: `${a.label} agent`,
      env: `${a.id.toUpperCase()}_AGENT_CLIENT_ID`,
      clientId: a.clientId,
      flows: [`authp-${a.id}`],
      // CIMD has no console registration: its redirect_uris live in the metadata document.
      cimd: a.id === 'cimd',
    })),
  ];
  return apps.filter((a) => a.clientId).map((a) => ({ ...a, current: a.flows.includes(currentFlow) }));
}

router.get('/tester/flows/:flow', gate, async (req, res) => {
  const steps = await flowSteps(req.params.flow);
  if (!steps) return res.status(404).json({ error: 'unknown_flow' });
  res.json({
    flow: req.params.flow,
    steps: publicSteps(steps),
    redirectUri: config.tester.redirectUri,
    redirectUris: config.tester.redirectUris,
    loginApps: loginApps(req.params.flow),
  });
});

router.post('/tester/run', gate, async (req, res) => {
  const { flow, stepId, values = {} } = req.body || {};
  const steps = await flowSteps(flow);
  const def = steps?.find((s) => s.id === stepId);
  if (!def) return res.status(404).json({ error: 'unknown_step' });

  try {
    // Fresh login: hand the browser an /authorize URL; the callback finishes the step.
    if (def.kind === 'subject' && values.fields?.mode === 'login') {
      const f = values.fields;
      const ep = await endpoints(f.issuer);
      const auth = resolveAuth(values.auth, def.auth);
      if (!String(auth.clientId || '').trim()) throw new Error('client_id is required for a fresh login.');
      const verifier = b64url(crypto.randomBytes(32));
      const state = b64url(crypto.randomBytes(16));
      const nonce = b64url(crypto.randomBytes(16));
      const redirectUri = String(f.redirectUri || '').trim() || config.tester.redirectUri;
      const q = new URLSearchParams({
        client_id: auth.clientId.trim(),
        response_type: 'code',
        scope: f.scopes || 'openid profile email',
        redirect_uri: redirectUri,
        state,
        nonce,
        code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
      });
      if (String(f.resource || '').trim()) q.set('resource', f.resource.trim());
      if (f.prompt) q.set('prompt', f.prompt);
      const authorizeUrl = `${ep.authorize}?${q}`;
      req.session.testerLogin = { flow, stepId, tokenUrl: ep.token, redirectUri, auth, useToken: f.useToken || 'id_token', verifier, state, authorizeUrl };
      return res.json({ ok: true, redirect: authorizeUrl, steps: [], outputs: {} });
    }

    const result = await runStep(def, values, req.session);
    res.json(result);
  } catch (err) {
    console.error(`[tester] ${flow} ${stepId}:`, err);
    res.json({ ok: false, steps: [failedStep(def, '', err.message)], outputs: {}, message: err.message });
  }
});

router.get('/tester/callback', async (req, res) => {
  const pending = req.session.testerLogin;
  if (!pending) return res.redirect(`${config.appBaseUrl}/?tester=error`);
  delete req.session.testerLogin;
  const meta = { id: pending.stepId, title: 'User Login (Tester)', badge: 'Access Token', from: 'User', to: 'IdP' };
  const t0 = buildAuthorizeStep({ redirectUri: pending.redirectUri }, pending.authorizeUrl, pending.state);
  t0.id = `${pending.stepId}.0`;

  let result;
  if (req.query.error) {
    const step = failedStep(meta, pending.authorizeUrl, `${req.query.error}: ${req.query.error_description || ''}`, 'GET');
    result = { ok: false, steps: [t0, step], outputs: {}, message: `The IdP returned ${req.query.error}.` };
  } else if (req.query.state !== pending.state) {
    result = { ok: false, steps: [t0, failedStep(meta, pending.redirectUri, 'state mismatch — the login response does not belong to this request.', 'GET')], outputs: {} };
  } else {
    const r = await tokenPost(meta, pending.tokenUrl, pending.auth, {}, {
      grant_type: 'authorization_code',
      code: String(req.query.code || ''),
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    });
    const outputs = { ...r.outputs };
    const token = outputs[pending.useToken];
    if (token) {
      outputs.token = token;
      outputs.subject_token_type = TOKEN_TYPES[pending.useToken];
    }
    result = {
      ok: r.ok && !!token,
      steps: [t0, ...r.steps],
      outputs,
      message: r.ok && !token ? `The login succeeded but returned no ${pending.useToken}.` : undefined,
    };
  }
  req.session.testerResults = { ...(req.session.testerResults || {}), [pending.flow]: { stepId: pending.stepId, ...result } };
  res.redirect(`${config.appBaseUrl}/?flow=${encodeURIComponent(pending.flow)}&tab=tester`);
});

router.get('/tester/login-result', gate, (req, res) => {
  const flow = String(req.query.flow || '');
  const result = req.session.testerResults?.[flow] || null;
  if (result) delete req.session.testerResults[flow];
  res.json({ result });
});

export default router;
