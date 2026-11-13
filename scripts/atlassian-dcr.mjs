#!/usr/bin/env node
// One-time: register this agent with Atlassian via Dynamic Client Registration (RFC 7591)
// for the "HI - Cross-App Access (Atlassian)" flow. Same call as the UI's
// "Register agent with Atlassian (DCR)" button.
//
//   node scripts/atlassian-dcr.mjs            # refuses if already registered
//   node scripts/atlassian-dcr.mjs --force    # new registration → NEW client_id
//
// Writes:
//   keys/atlassian-dcr.json           client_id + client_secret (gitignored)
//   registrations/atlassian-dcr.json  redacted request/response record (commit this —
//                                     it's what the UI's Prerequisite panel shows)
// Then: set the printed client_id on the Atlassian resource in Okta's Cross-App Access
// config, and for deployments set ATLASSIAN_XAA_CLIENT_ID / ATLASSIAN_XAA_CLIENT_SECRET.
import fs from 'fs';
import { registrationStatus, registerAtlassianClient, CREDENTIALS_FILE, RECORD_FILE } from '../server/xaa/atlassianDcr.js';

const force = process.argv.includes('--force');
const status = registrationStatus();

if (!status.configured) {
  console.error('✗ Set ATLASSIAN_XAA_ISSUER in .env first (e.g. https://auth.atlassian.com/<id>).');
  process.exit(1);
}
if (status.registered && !force) {
  console.error(`✗ Already registered: client_id ${status.clientId} (from ${status.credentialSource}).`);
  console.error('  Re-run with --force to create a NEW registration (and update Okta with the new client_id).');
  process.exit(1);
}

console.log(`→ POST ${status.registrationUrl}`);
const r = await registerAtlassianClient();
if (r.step) {
  console.log(`← HTTP ${r.step.response.status}`);
  console.log(JSON.stringify(r.step.response.body, null, 2));
}
if (!r.ok) {
  console.error(`✗ ${r.error}`);
  process.exit(1);
}

console.log(`\n✓ Registered client_id: ${r.clientId}  (client_secret returned: ${r.hasSecret})`);
console.log(`  credentials → ${CREDENTIALS_FILE}`);
console.log(`  record      → ${RECORD_FILE}  (commit this file)`);
if (fs.existsSync(CREDENTIALS_FILE)) {
  console.log('\nNext:');
  console.log('  1. Okta Admin → Cross-App Access: set this client_id on the Atlassian resource.');
  console.log('  2. Deployments: set ATLASSIAN_XAA_CLIENT_ID / ATLASSIAN_XAA_CLIENT_SECRET (values in the credentials file).');
}
