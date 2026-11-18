// Tester — client authentication for any token request, driven entirely by what the
// operator typed in the Tester tab (falling back to the flow's configured defaults).
//
//   private_key_jwt      client_assertion signed with a key file on this server or a
//                        pasted PEM (never written to disk)
//   client_secret_basic  Authorization: Basic base64(client_id:client_secret)
//   client_secret_post   client_id + client_secret in the body
//   none                 client_id only (public client)
import path from 'path';
import { fileURLToPath } from 'url';
import { buildClientAssertion } from '../xaa/clientAssertion.js';
import { captureFormPost } from '../xaa/capture.js';
import { decodeJwt } from '../util/jwt.js';

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const AUTH_METHODS = ['private_key_jwt', 'client_secret_basic', 'client_secret_post', 'none'];

const METHOD_DESC = {
  private_key_jwt: 'private_key_jwt — client_assertion signed with the private key (aud = token endpoint)',
  client_secret_basic: 'client_secret_basic — Authorization: Basic base64(client_id:client_secret)',
  client_secret_post: 'client_secret_post — client_id + client_secret in the request body',
  none: 'none — client_id only (public client)',
};

/**
 * A key file typed into the Tester must live inside this project (keys/…) — the Tester
 * must not become a way to read arbitrary PEM files off the server.
 */
function safeKeyFile(p) {
  if (!p || !String(p).trim()) throw new Error('No private key file set — enter a path under this project (e.g. keys/agent.pem) or paste a PEM.');
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(ROOT, p);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Private key file must be inside the project directory (got ${p}). Paste the PEM instead.`);
  }
  return abs;
}

/**
 * Merge the operator's auth values with the step's configured defaults. Secrets that are
 * left blank fall back to the configured secret (which the browser never sees).
 */
export function resolveAuth(input = {}, def = {}) {
  const d = def.default || {};
  const a = { ...d, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  a.method = a.method || 'private_key_jwt';
  if (a.method.startsWith('client_secret') && !String(a.clientSecret || '').trim()) a.clientSecret = def._secret;
  if (a.keySource !== 'pem' && !String(a.privateKeyFile || '').trim()) a.privateKeyFile = d.privateKeyFile;
  return a;
}

/** Build the headers/params that authenticate `auth` at `tokenUrl`. Throws on bad input. */
export async function buildAuth(auth, tokenUrl) {
  const method = auth.method || 'private_key_jwt';
  const clientId = String(auth.clientId || '').trim();
  if (!clientId) throw new Error('client_id is required.');
  const headers = {};
  const params = {};
  const secrets = [];

  if (method === 'private_key_jwt') {
    const usePem = auth.keySource === 'pem';
    if (usePem && !String(auth.privateKeyPem || '').trim()) throw new Error('Key source is "Paste PEM" but no PEM was pasted.');
    const assertion = await buildClientAssertion({
      clientId,
      audience: String(auth.assertionAudience || '').trim() || tokenUrl,
      kid: String(auth.kid || '').trim() || undefined,
      privateKeyFile: usePem ? undefined : safeKeyFile(auth.privateKeyFile),
      privateKeyPem: usePem ? auth.privateKeyPem : undefined,
    });
    if (auth.sendClientId) params.client_id = clientId;
    params.client_assertion_type = CLIENT_ASSERTION_TYPE;
    params.client_assertion = assertion;
  } else if (method === 'client_secret_basic' || method === 'client_secret_post') {
    const secret = String(auth.clientSecret || '');
    if (!secret) throw new Error(`${method} needs a client secret — none was entered and none is configured.`);
    secrets.push(secret);
    if (method === 'client_secret_basic') {
      // RFC 6749 §2.3.1: form-urlencode id and secret before base64.
      const creds = `${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`;
      headers.Authorization = `Basic ${Buffer.from(creds).toString('base64')}`;
    } else {
      params.client_id = clientId;
      params.client_secret = secret;
    }
  } else if (method === 'none') {
    params.client_id = clientId;
  } else {
    throw new Error(`Unknown client authentication method '${method}'.`);
  }
  return { headers, params, secrets, note: `Client authentication: ${METHOD_DESC[method]}.` };
}

const maskValue = (v = '') => (v.length > 12 ? `${v.slice(0, 4)}…${v.slice(-2)}` : '••••');

/** Scrub secrets (raw and url-encoded) and Basic credentials out of a captured step. */
export function redactStep(captured, secrets = []) {
  const scrub = (s) => {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const secret of secrets.filter(Boolean)) {
      for (const raw of [encodeURIComponent(secret), secret]) out = out.split(raw).join(`<secret:${maskValue(secret)}>`);
    }
    return out.replace(/Basic [A-Za-z0-9+/=]{8,}/g, 'Basic <base64(client_id:client_secret)>');
  };
  captured.request.body = scrub(captured.request.body);
  captured.request.url = scrub(captured.request.url);
  captured.code = scrub(captured.code);
  for (const k of Object.keys(captured.request.headers || {})) captured.request.headers[k] = scrub(captured.request.headers[k]);
  return captured;
}

/** A step that never reached the wire — shown as a failed card. */
export function failedStep(meta, url, message, method = 'POST') {
  return {
    id: meta.id,
    title: meta.title,
    badge: meta.badge || 'Error',
    from: meta.from || 'Agent',
    to: meta.to || 'Server',
    ok: false,
    request: { method, url: url || '', headers: {}, body: '(request not sent)' },
    response: { status: 0, headers: {}, body: { error: 'tester_error', error_description: message } },
    token: null,
    code: '',
  };
}

// Pull a username/password, client id/secret, or access token out of a credential object
// (vaulted secret / service account) — mirrors the extraction the chat flows do.
function credOutputs(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const vals = Object.values(obj);
  const pick = (...vs) => vs.find((v) => v != null && v !== '');
  const out = {
    'cred.username': pick(obj.username, obj.user, vals[0]),
    'cred.password': pick(obj.password, obj.pass, vals[1]),
    'cred.client_id': pick(obj.client_id, obj.clientId, obj.username, vals[0]),
    'cred.client_secret': pick(obj.client_secret, obj.clientSecret, obj.password, vals[1]),
    'cred.access_token': pick(obj.access_token, obj.accessToken, obj.token, vals[0]),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
}

/** Everything from a token response a later step might bind to. */
export function tokenOutputs(body) {
  if (!body || typeof body !== 'object') return {};
  const out = {};
  for (const k of ['access_token', 'refresh_token', 'id_token', 'issued_token_type', 'token_type', 'scope', 'interaction_uri']) {
    if (typeof body[k] === 'string') out[k] = body[k];
  }
  if (out.refresh_token || out.access_token) out.refresh_or_access = out.refresh_token || out.access_token;
  for (const f of ['vaulted_secret', 'service_account']) {
    if (body[f] && typeof body[f] === 'object') {
      out[f] = JSON.stringify(body[f]);
      Object.assign(out, credOutputs(body[f]));
    }
  }
  // id-JAG claims are handy for later fields (e.g. Atlassian aud_tenant).
  const claims = decodeJwt(out.access_token)?.payload;
  if (claims?.aud_tenant) out['claims.aud_tenant'] = String(claims.aud_tenant);
  return out;
}

/**
 * One authenticated form POST to a token endpoint, captured as a step card.
 * Returns { steps, outputs, ok, body }.
 */
export async function tokenPost(meta, tokenUrl, authInput, authDef, params, extraHeaders = {}) {
  if (!String(tokenUrl || '').trim()) {
    return { steps: [failedStep(meta, '', 'Token URL is required.')], outputs: {}, ok: false };
  }
  let a;
  try {
    a = await buildAuth(resolveAuth(authInput, authDef), tokenUrl);
  } catch (err) {
    return { steps: [failedStep(meta, tokenUrl, err.message)], outputs: {}, ok: false };
  }
  const { captured, responseBody, ok } = await captureFormPost(
    { ...meta, tokenField: 'access_token' },
    tokenUrl,
    { ...extraHeaders, ...a.headers },
    { ...params, ...a.params }
  );
  captured.note = [meta.note, a.note].filter(Boolean).join(' ');
  redactStep(captured, a.secrets);
  return { steps: [captured], outputs: ok ? tokenOutputs(responseBody) : tokenOutputs(responseBody && { interaction_uri: responseBody.interaction_uri }), ok, body: responseBody };
}
