import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { mask } from './atlassian.js';

// HI - Cross-App Access (Atlassian) — one-time prerequisite: the agent registers itself
// with Atlassian's authorization server via Dynamic Client Registration (RFC 7591) and
// gets back the client_id / client_secret that T3 presents with the id-JAG.
//
// Two files come out of a registration:
//   keys/atlassian-dcr.json           — the CREDENTIALS (client_secret). Gitignored.
//   registrations/atlassian-dcr.json  — the REDACTED request/response record shown in the
//                                       UI's "Prerequisite" panel. Safe to commit, so the
//                                       record survives redeploys (e.g. Render's ephemeral
//                                       disk), where the credentials come from env instead.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CREDENTIALS_FILE = path.join(ROOT, 'keys', 'atlassian-dcr.json');
export const RECORD_FILE = path.join(ROOT, 'registrations', 'atlassian-dcr.json');

// Response fields that are credentials, not identifiers — never shown or stored in the record.
const SECRET_FIELDS = ['client_secret', 'registration_access_token'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
}

/**
 * The DCR client credentials T3 uses: env (ATLASSIAN_XAA_CLIENT_ID/_SECRET) wins, else the
 * file written by the registration. Returns null when the agent isn't registered.
 */
export function getAtlassianCredentials() {
  const { clientId, clientSecret } = config.xaaAtlassian;
  // client_secret is optional: if Atlassian registered a public client, T3 sends client_id only.
  if (clientId) return { clientId, clientSecret, source: 'env' };
  const file = readJson(CREDENTIALS_FILE);
  if (file?.client_id) {
    return { clientId: file.client_id, clientSecret: file.client_secret || undefined, source: 'file' };
  }
  return null;
}

export function getRegistrationRecord() {
  return readJson(RECORD_FILE);
}

/** Status for the UI panel — never includes the secret. */
export function registrationStatus() {
  const creds = getAtlassianCredentials();
  const record = getRegistrationRecord();
  return {
    configured: !!config.xaaAtlassian.registrationUrl,
    registrationUrl: config.xaaAtlassian.registrationUrl || null,
    registered: !!creds,
    credentialSource: creds?.source || null,
    clientId: creds?.clientId || record?.clientId || null,
    // The record belongs to a different client than the credentials in use (e.g. env was
    // updated after a re-registration) — the panel flags it.
    recordMatches: !record || !creds || record.clientId === creds.clientId,
    registeredAt: record?.registeredAt || null,
    step: record?.step || null,
  };
}

function redact(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  for (const f of SECRET_FIELDS) if (out[f]) out[f] = `${mask(String(out[f]))} [redacted]`;
  return out;
}

// Response headers worth showing; cookies and tracing noise are dropped.
function shownHeaders(h) {
  const keep = ['content-type', 'cache-control', 'atl-traceid', 'date'];
  const out = {};
  for (const k of keep) if (h.get(k)) out[k] = h.get(k);
  return out;
}

/**
 * POST <issuer>/dcr/register. On success writes both files and returns
 * { ok, step, clientId }. The returned step is already redacted.
 */
export async function registerAtlassianClient() {
  const cfg = config.xaaAtlassian;
  if (!cfg.registrationUrl) {
    return { ok: false, error: 'Set ATLASSIAN_XAA_ISSUER (the Atlassian authorization-server issuer) first.' };
  }

  // jwt-bearer is the grant T3 uses; authorization_code / refresh_token are what an MCP
  // client normally registers, and Atlassian expects them alongside. No
  // token_endpoint_auth_method — Atlassian returns its default (client_secret_post).
  const payload = {
    client_name: cfg.clientName,
    redirect_uris: [cfg.redirectUri],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
    response_types: ['code'],
  };
  const reqHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };

  let status = 0;
  let body;
  let headers = {};
  try {
    const res = await fetch(cfg.registrationUrl, { method: 'POST', headers: reqHeaders, body: JSON.stringify(payload) });
    status = res.status;
    headers = shownHeaders(res.headers);
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch (err) {
    body = { error: 'network_error', error_description: err.message };
  }

  const ok = (status === 200 || status === 201) && !!body?.client_id;
  const step = {
    id: 'P0',
    title: 'Dynamic Client Registration (one-time)',
    badge: 'DCR',
    from: 'Agent',
    to: 'Atlassian Auth Server',
    ok,
    note: ok
      ? 'One-time prerequisite. The client_id and client_secret returned here are what T3 sends to auth.atlassian.com/oauth/token together with the id-JAG. Configure this client_id on the Atlassian resource in Okta’s Cross-App Access settings.'
      : 'Registration failed — no client credentials were stored.',
    expandHeaders: false,
    request: { method: 'POST', url: cfg.registrationUrl, headers: reqHeaders, body: JSON.stringify(payload, null, 2) },
    response: { status, headers, body: redact(body) },
    token: null,
    code:
      `curl -X POST '${cfg.registrationUrl}' \\\n` +
      `  -H 'Content-Type: application/json' \\\n` +
      `  -H 'Accept: application/json' \\\n` +
      `  -d '${JSON.stringify(payload)}'`,
  };

  if (!ok) return { ok: false, step, error: `Atlassian DCR failed (HTTP ${status || 'network error'}).` };

  const registeredAt = new Date().toISOString();
  writeJson(
    CREDENTIALS_FILE,
    {
      issuer: cfg.issuer,
      client_id: body.client_id,
      client_secret: body.client_secret,
      ...(body.registration_access_token ? { registration_access_token: body.registration_access_token } : {}),
      ...(body.registration_client_uri ? { registration_client_uri: body.registration_client_uri } : {}),
      registered_at: registeredAt,
    },
    0o600
  );
  writeJson(RECORD_FILE, { registeredAt, issuer: cfg.issuer, clientId: body.client_id, step });

  return { ok: true, step, clientId: body.client_id, hasSecret: !!body.client_secret, registeredAt };
}
