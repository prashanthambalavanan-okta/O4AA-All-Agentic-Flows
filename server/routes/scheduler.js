import { Router } from 'express';
import { runServiceFlow, runNhiA2aFlow, runAtlassianFlow, runAtlassianTokenFlow } from './ask.js';

// Tool allow-list per schedulable flow — all run on a pure service identity
// (client_credentials + private_key_jwt), so this route is intentionally
// unauthenticated: no req.session check anywhere below. Any external scheduler
// (cron, a CI job, curl) can drive it exactly like the in-app "Start schedule" panel.
const SCHEDULABLE_FLOWS = {
  'client-credentials': ['get_inventory_details', 'get_last_5_shipments'],
  'nhi-a2a': ['get_customer_arr', 'get_customer_payment_details'],
  'secrets-atlassian': ['get_scrum_board_tasks'],
  'secrets-atlassian-token': ['get_scrum_board_tasks'],
};

const router = Router();

router.post('/scheduler/run', async (req, res) => {
  const { flow, tool } = req.body || {};
  const allowedTools = SCHEDULABLE_FLOWS[flow];
  if (!allowedTools) {
    return res.status(400).json({ error: 'unknown_flow', message: `'${flow}' is not a schedulable flow.` });
  }
  if (!allowedTools.includes(tool)) {
    return res.status(400).json({ error: 'unknown_tool', message: `'${tool}' is not valid for '${flow}'.` });
  }

  const steps = [];
  const startedAt = Date.now();
  try {
    const answer =
      flow === 'nhi-a2a'
        ? await runNhiA2aFlow(tool, steps)
        : flow === 'secrets-atlassian'
        ? await runAtlassianFlow(steps)
        : flow === 'secrets-atlassian-token'
        ? await runAtlassianTokenFlow(steps)
        : await runServiceFlow(tool, steps);
    res.json({
      ok: true,
      answer,
      toolName: tool,
      flow,
      steps,
      durationMs: Date.now() - startedAt,
      ranAt: startedAt,
    });
  } catch (err) {
    console.error('[scheduler/run] unexpected error:', err);
    res.json({
      ok: false,
      answer: `Unexpected error while running the chain: ${err.message}`,
      toolName: tool,
      flow,
      steps,
      durationMs: Date.now() - startedAt,
      ranAt: startedAt,
    });
  }
});

export default router;
