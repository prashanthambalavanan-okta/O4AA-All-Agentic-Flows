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
  } else if (flow === 'xaa-webapp') {
    if (!req.session.webappAccessToken) return { error: 'not_authenticated' };
  } else if (!req.session.user) {
    return { error: 'not_authenticated' };
  }
  return null;
}
