import { Router } from 'express';
import { registrationStatus, registerAtlassianClient } from '../xaa/atlassianDcr.js';
import { requireFlowAuth } from './authGate.js';

// HI - Cross-App Access (Atlassian) — the one-time DCR prerequisite shown above the steps.
const router = Router();
const FLOW = 'xaa-atlassian';

router.get('/xaa-atlassian/registration', (req, res) => {
  const authError = requireFlowAuth(FLOW, req);
  if (authError) return res.status(401).json(authError);
  res.json(registrationStatus());
});

// Registers the agent with Atlassian. Refuses when already registered unless { force: true },
// because a new registration means a new client_id that must also be updated in Okta.
router.post('/xaa-atlassian/register', async (req, res) => {
  const authError = requireFlowAuth(FLOW, req);
  if (authError) return res.status(401).json(authError);

  const current = registrationStatus();
  if (current.registered && req.body?.force !== true) {
    return res.status(409).json({
      error: 'already_registered',
      error_description: 'The agent is already registered with Atlassian. Re-registering creates a NEW client_id that must also be updated in Okta.',
      ...current,
    });
  }

  const r = await registerAtlassianClient();
  if (!r.ok) return res.status(502).json({ error: 'registration_failed', error_description: r.error, ...registrationStatus(), step: r.step || null });
  console.log(`[xaa-atlassian] registered Atlassian client ${r.clientId}`);
  res.json({ ...registrationStatus(), justRegistered: true });
});

export default router;
