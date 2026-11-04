// Force login (OIDC prompt=login) — a per-flow toggle, remembered in localStorage.
// When on, entering the flow always goes through that flow's /authorize with
// prompt=login, so Okta re-authenticates the user even if an Okta session exists.
import { login, a2aLogin, webappLogin, authpLogin } from './api.js';

const key = (flowId) => `o4aa.forceLogin.${flowId}`;

export function isForceLogin(flowId) {
  return localStorage.getItem(key(flowId)) === '1';
}

export function setForceLogin(flowId, on) {
  if (on) localStorage.setItem(key(flowId), '1');
  else localStorage.removeItem(key(flowId));
}

// Flows whose login is an OIDC /authorize the app starts. Excludes SAML (IdP-initiated,
// no prompt param) and NHI flows (no user login in the chain).
export function supportsForceLogin(flow) {
  return flow.prependLogin !== false && flow.authContext !== 'saml';
}

/** Start the login that belongs to `flow`; `force` adds prompt=login. */
export function startFlowLogin(flow, { force = false } = {}) {
  const opts = force ? { prompt: 'login' } : undefined;
  if (flow.authContext === 'authp') return authpLogin(flow.authPattern, flow.id, opts);
  if (flow.authContext === 'a2a') return a2aLogin(flow.id, opts);
  if (flow.authContext === 'webapp') return webappLogin(flow.id, opts);
  return login(flow.id, opts);
}
