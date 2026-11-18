#!/usr/bin/env node
// Add the Tester's Fresh-login callback URIs to the Okta apps the Tester logs in with.
//
//   OKTA_API_TOKEN=… node scripts/add-tester-redirects.mjs            # dry run: show current → new
//   OKTA_API_TOKEN=… node scripts/add-tester-redirects.mjs --apply    # write the change
//   node scripts/add-tester-redirects.mjs --token-file local-testing/okta-api-token [--apply]
//
// Existing redirect URIs are kept; only missing Tester URIs are appended. The CIMD agent is
// skipped (its redirect_uris live in its metadata document, not in Okta).
//
// Per app it tries, in order:
//   1. Apps API    GET/PUT /api/v1/apps/{clientId}          (OIDC apps: app id = client id)
//   2. Clients API GET/PUT /oauth2/v1/clients/{clientId}    (other OAuth client registrations)
import fs from 'fs';
import { config } from '../server/config.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tokenFileArg = args.indexOf('--token-file');
const token = (tokenFileArg >= 0 ? fs.readFileSync(args[tokenFileArg + 1], 'utf8') : process.env.OKTA_API_TOKEN || '').trim();
if (!token) {
  console.error('Set OKTA_API_TOKEN or pass --token-file <path>.');
  process.exit(1);
}

const ORG = (process.env.OKTA_ORG_URL || config.okta.issuer || '').replace(/\/oauth2\/.*$/, '').replace(/\/$/, '');
const URIS = config.tester.redirectUris;
const ap = config.authPatterns.agents;
const APPS = [
  ['Agent login app (OKTA_CLIENT_ID)', config.okta.clientId],
  ['Web App (WEBAPP_CLIENT_ID)', config.webapp.clientId],
  ['A2A login app (A2A_OKTA_CLIENT_ID)', config.a2a.okta.clientId],
  ['Public / Private key agent', ap.pkjwt.clientId],
  ['Client ID / Client secret agent', ap.secret.clientId],
  ['Client ID only agent', ap.public.clientId],
].filter(([, id]) => id);

const headers = { Authorization: `SSWS ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' };

async function call(method, path, body) {
  const res = await fetch(`${ORG}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

const errText = (r) => `HTTP ${r.status}${r.body?.errorSummary ? ` — ${r.body.errorSummary}` : r.body?.error_description ? ` — ${r.body.error_description}` : ''}`;

async function viaAppsApi(clientId) {
  const r = await call('GET', `/api/v1/apps/${encodeURIComponent(clientId)}`);
  if (r.status !== 200 || !r.body?.settings?.oauthClient) return { found: false, why: `Apps API: ${errText(r)}` };
  const app = r.body;
  const current = app.settings.oauthClient.redirect_uris || [];
  const missing = URIS.filter((u) => !current.includes(u));
  return {
    found: true,
    api: 'Apps API',
    current,
    missing,
    write: async () => {
      const { _links, _embedded, ...rest } = app;
      rest.settings = { ...rest.settings, oauthClient: { ...rest.settings.oauthClient, redirect_uris: [...current, ...missing] } };
      const w = await call('PUT', `/api/v1/apps/${encodeURIComponent(app.id)}`, rest);
      if (w.status !== 200) return { ok: false, why: errText(w) };
      const after = (await call('GET', `/api/v1/apps/${encodeURIComponent(app.id)}`)).body?.settings?.oauthClient?.redirect_uris || [];
      return { ok: URIS.every((u) => after.includes(u)), after };
    },
  };
}

async function viaClientsApi(clientId) {
  const r = await call('GET', `/oauth2/v1/clients/${encodeURIComponent(clientId)}`);
  if (r.status !== 200 || !r.body?.client_id) return { found: false, why: `Clients API: ${errText(r)}` };
  const client = r.body;
  const current = client.redirect_uris || [];
  const missing = URIS.filter((u) => !current.includes(u));
  return {
    found: true,
    api: 'Clients API',
    current,
    missing,
    write: async () => {
      const { _links, client_secret, client_secret_expires_at, client_id_issued_at, ...rest } = client;
      const w = await call('PUT', `/oauth2/v1/clients/${encodeURIComponent(clientId)}`, { ...rest, redirect_uris: [...current, ...missing] });
      if (w.status !== 200) return { ok: false, why: errText(w) };
      const after = (await call('GET', `/oauth2/v1/clients/${encodeURIComponent(clientId)}`)).body?.redirect_uris || [];
      return { ok: URIS.every((u) => after.includes(u)), after };
    },
  };
}

console.log(`Org: ${ORG}\nTester redirect URIs:\n${URIS.map((u) => `  ${u}`).join('\n')}\nMode: ${apply ? 'APPLY' : 'dry run (add --apply to write)'}\n`);
const summary = [];
for (const [label, clientId] of APPS) {
  let target = await viaAppsApi(clientId);
  const tried = [target.why];
  if (!target.found) {
    target = await viaClientsApi(clientId);
    tried.push(target.why);
  }
  console.log(`■ ${label}  (${clientId})`);
  if (!target.found) {
    console.log(`  not updatable via API — ${tried.filter(Boolean).join('; ')}`);
    summary.push([label, 'manual']);
    continue;
  }
  console.log(`  via ${target.api}; current redirect URIs:`);
  for (const u of target.current) console.log(`    ${u}`);
  if (!target.missing.length) {
    console.log('  ✓ already has both Tester URIs');
    summary.push([label, 'already set']);
    continue;
  }
  console.log(`  + would add: ${target.missing.join(', ')}`);
  if (!apply) {
    summary.push([label, 'would update']);
    continue;
  }
  const w = await target.write();
  console.log(w.ok ? '  ✓ updated and verified' : `  ✗ update failed — ${w.why || 'URIs missing after update'}`);
  summary.push([label, w.ok ? 'updated' : 'FAILED']);
}
console.log('\nSummary:');
for (const [l, s] of summary) console.log(`  ${s.padEnd(13)} ${l}`);
