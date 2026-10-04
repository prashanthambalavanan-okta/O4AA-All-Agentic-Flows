import { SignJWT } from 'jose';
import { config } from '../config.js';
import { loadPrivateKey, loadPrivateKeyPem } from '../util/privateKey.js';

/**
 * Build a signed private_key_jwt client assertion (RFC 7523 §2.2):
 * iss=sub=clientId, aud=the token endpoint it is sent to.
 *
 * `privateKeyPem` (a key pasted into the runner UI) wins over `privateKeyFile`; this is
 * the single funnel every flow's signing goes through, so supporting it here covers all
 * of them.
 */
export async function buildClientAssertion({ clientId, audience, kid, privateKeyFile, privateKeyPem }) {
  const key = privateKeyPem
    ? loadPrivateKeyPem(privateKeyPem)
    : loadPrivateKey(privateKeyFile || config.agent.privateKeyFile);
  const now = Math.floor(Date.now() / 1000);
  const jti = `${now}-${Math.random().toString(36).slice(2)}-xaa`;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(jti)
    .sign(key);
}

/**
 * T2 — assertion for the agent client at the IdP token endpoint.
 * `ov` carries the step-by-step runner's per-run overrides; every field falls back to
 * the configured value, so the chat path (which passes nothing) is unchanged.
 */
export function buildAgentClientAssertion(ov = {}) {
  return buildClientAssertion({
    clientId: ov.clientId ?? config.agent.clientId,
    audience: ov.assertionAudience ?? config.agent.assertionAudience,
    kid: ov.kid ?? config.agent.kid,
    privateKeyFile: ov.privateKeyFile ?? config.agent.privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });
}

/** T2/T3 — assertion for the SAML flow's agent client at the IdP token endpoint (dedicated client_id, same agent cert). */
export function buildSamlAgentClientAssertion(ov = {}) {
  return buildClientAssertion({
    clientId: ov.clientId ?? config.saml.clientId,
    audience: ov.assertionAudience ?? config.agent.assertionAudience,
    kid: ov.kid ?? config.agent.kid,
    privateKeyFile: ov.privateKeyFile ?? config.agent.privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });
}

/**
 * T3 — assertion for the resource client at the resource token endpoint (same agent
 * cert). `clientIdOverride` lets a flow whose id-JAG was minted under a different
 * agent client_id (e.g. hi-saml's AGENT_CLIENT_ID_SAML) redeem it as that same client.
 */
export function buildResourceClientAssertion(clientIdOverride, ov = {}) {
  return buildClientAssertion({
    clientId: ov.clientId ?? (clientIdOverride || config.resource.clientId),
    audience: ov.assertionAudience ?? config.resource.assertionAudience,
    kid: ov.kid ?? config.resource.kid,
    privateKeyFile: ov.privateKeyFile ?? config.agent.privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });
}

/** Service App (client credentials) flow — assertion signed with the SERVICE cert. */
export function buildServiceClientAssertion(audience, ov = {}) {
  return buildClientAssertion({
    clientId: ov.clientId ?? config.service.clientId,
    audience: ov.assertionAudience ?? audience,
    kid: ov.kid ?? config.service.kid,
    privateKeyFile: ov.privateKeyFile ?? config.service.privateKeyFile,
    privateKeyPem: ov.privateKeyPem,
  });
}
