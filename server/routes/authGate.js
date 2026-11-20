import { decodeJwt } from '../util/jwt.js';

// Per-flow session auth gate, shared by /api/ask and /api/runner.
//
// The demo keeps four independent login contexts in one session (regular OIDC, A2A,
// web app, SAML), so "is this caller authenticated?" depends on which flow is running.

// Which login context each flow runs on. 'none' means the flow needs no user login
// at all (there is no such flow today — client-credentials still gates on the regular
// login so the demo has a signed-in operator).
export const FLOW_AUTH_CONTEXT = {
  xaa: 'default',
  'xaa-webapp': 'webapp',
  'hi-saml': 'saml',
  secrets: 'default',
  'secrets-atlassian': 'default',
  'secrets-atlassian-token': 'default',
  'service-account': 'default',
  'client-credentials': 'default',
  'hi-a2a': 'a2a',
  'nhi-a2a': 'a2a-or-default',
  'sts-github': 'default',
  'sts-atlassian': 'default',
  'xaa-atlassian': 'default',
  'xaa-gcp': 'default',
  // Authentication Patterns — each agent has its own login context (session.authp[pattern]).
  'authp-pkjwt': 'authp',
  'authp-secret': 'authp',
  'authp-public': 'authp',
  'authp-cimd': 'authp',
};

// Returns null when the caller is authenticated for this flow, otherwise the JSON
// body to respond with (always paired with a 401 by the caller).
export function requireFlowAuth(flow, req) {
  // A2A flows use the A2A login context; other user flows use the regular login.
  if (flow === 'hi-a2a') {
    if (!req.session.a2aAccessToken) return { error: 'not_authenticated' };
  } else if (flow === 'nhi-a2a') {
    if (!req.session.user && !req.session.a2aUser) return { error: 'not_authenticated' };
  } else if (flow === 'hi-saml') {
    if (!req.session.samlAssertion) return { error: 'not_authenticated' };
  } else if (typeof flow === 'string' && flow.startsWith('authp-')) {
    if (!req.session.authp?.[flow.slice('authp-'.length)]?.idToken) return { error: 'not_authenticated' };
  } else if (flow === 'xaa-webapp') {
    if (!req.session.webappAccessToken) return { error: 'not_authenticated' };
  } else if (!req.session.user) {
    return { error: 'not_authenticated' };
  }
  return null;
}

// ── Subject-token expiry ──
// Every user flow's chain starts from a token stored at login. If that token has
// expired, the chain would only fail at T2 with a confusing error, so check it up
// front; the client then signs the user out and returns to the login page.
const CLOCK_SKEW_SECONDS = 30;

// The token each flow uses as its T2 subject (mirrors the dispatch in ask.js).
// NHI flows mint a fresh service token on every run, so they have nothing to check.
function subjectTokenFor(flow, session) {
  if (typeof flow === 'string' && flow.startsWith('authp-')) {
    return { kind: 'jwt', value: session.authp?.[flow.slice('authp-'.length)]?.idToken };
  }
  switch (flow) {
    case 'xaa-webapp':
      return { kind: 'jwt', value: session.webappAccessToken };
    case 'hi-a2a':
      return { kind: 'jwt', value: session.a2aAccessToken };
    case 'hi-saml':
      return { kind: 'saml', value: session.samlAssertion };
    case 'client-credentials':
    case 'nhi-a2a':
    case 'secrets-atlassian':
    case 'secrets-atlassian-token':
      return null;
    default: // xaa, secrets, service-account, sts-github, sts-atlassian, xaa-atlassian, xaa-gcp
      return { kind: 'jwt', value: session.idToken };
  }
}

// Expiry as epoch seconds, or null when it can't be determined (then we don't block).
function expiresAt({ kind, value }) {
  if (!value) return null;
  if (kind === 'jwt') {
    const exp = decodeJwt(value)?.payload?.exp;
    return typeof exp === 'number' ? exp : null;
  }
  // SAML: base64 assertion XML — the assertion's validity window ends at
  // Conditions/@NotOnOrAfter.
  try {
    const xml = Buffer.from(value, 'base64').toString('utf8');
    const m = xml.match(/<(?:\w+:)?Conditions\b[^>]*\bNotOnOrAfter="([^"]+)"/);
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  } catch {
    return null;
  }
}

/**
 * Returns null when the flow's subject token is still valid (or the flow has none),
 * otherwise the 401 JSON body: { error: 'token_expired', expiredAt }.
 */
export function requireValidSubjectToken(flow, req) {
  const subject = subjectTokenFor(flow, req.session);
  if (!subject) return null;
  const exp = expiresAt(subject);
  if (exp === null) return null;
  if (Date.now() / 1000 < exp - CLOCK_SKEW_SECONDS) return null;
  return {
    error: 'token_expired',
    error_description: `The ${subject.kind === 'saml' ? 'SAML assertion' : 'subject token'} for this flow expired at ${new Date(exp * 1000).toISOString()}. Sign in again.`,
    expiredAt: new Date(exp * 1000).toISOString(),
  };
}
