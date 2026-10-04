import { config } from '../config.js';
import { decodeJwt } from '../util/jwt.js';

// The MCP tool-call step builders and answer summarizer, shared by the chat route
// (/api/ask) and the step-by-step runner (/api/runner) so both render the final hop
// of every flow identically.

export function maskToken(t) {
  if (!t || t.length < 24) return t;
  return `${t.slice(0, 12)}…${t.slice(-8)}`;
}

// Build the MCP tool-call step manually — it's an in-process call, not HTTP, but we
// render it with the same shape and show the bearer access token in use.
export function buildMcpStep(toolName, accessToken, result, validation, opts = {}) {
  const { id = 'T4', from = 'Agent', to = 'Inventory MCP' } = opts;
  const status = validation.ok ? 200 : validation.verified ? 403 : 401;
  const body = validation.ok
    ? { tokenValidation: validation, data: result }
    : {
        error: validation.verified ? 'insufficient_scope' : 'invalid_token',
        error_description: validation.verified
          ? `Token is missing required scope(s): ${validation.requiredScopes.join(', ')}`
          : `Access token failed validation${validation.error ? ` (${validation.error})` : ''}`,
        tokenValidation: validation,
      };
  return {
    id,
    title: `MCP Tool Call · ${toolName}`,
    badge: 'MCP',
    from,
    to,
    ok: validation.ok,
    request: {
      method: 'POST',
      url: `${config.agent.resource || 'mcp://inventory/'}tools/call`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${maskToken(accessToken)}`,
      },
      body: JSON.stringify({ method: 'tools/call', params: { name: toolName, arguments: {} } }, null, 2),
    },
    response: { status, headers: { 'Content-Type': 'application/json' }, body },
    token: decodeJwt(accessToken),
    code: `# MCP tools/call with the resource access token\ncurl -X POST '<mcp-endpoint>/tools/call' \\\n  -H 'Authorization: Bearer ${maskToken(accessToken)}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ name: toolName, arguments: {} })}'`,
  };
}

// T3 of the Secrets / Service Account flows: call the MCP with HTTP Basic auth
// using the retrieved credentials. The MCP validates them against config.mcpBasic.
export function validateBasic(creds) {
  return !!(
    config.mcpBasic.username &&
    config.mcpBasic.password &&
    creds &&
    creds.username === config.mcpBasic.username &&
    creds.password === config.mcpBasic.password
  );
}

export function buildBasicMcpStep(toolName, creds, result, ok) {
  const masked = '•'.repeat(Math.max(4, (creds?.password || '').length));
  const encoded = Buffer.from(`${creds?.username || ''}:${masked}`).toString('base64');
  const status = ok ? 200 : 401;
  const body = ok
    ? { basicAuth: { username: creds.username, validated: true }, data: result }
    : {
        error: 'invalid_credentials',
        error_description: 'The presented Basic credentials did not match the MCP server configuration.',
        basicAuth: { username: creds?.username, validated: false },
      };
  return {
    id: 'T3',
    title: `MCP Tool Call · ${toolName}`,
    badge: 'MCP',
    from: 'Agent',
    to: 'Inventory MCP',
    ok,
    request: {
      method: 'POST',
      url: 'mcp://inventory/tools/call',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${encoded}` },
      body: JSON.stringify({ method: 'tools/call', params: { name: toolName, arguments: {} } }, null, 2),
    },
    response: { status, headers: { 'Content-Type': 'application/json' }, body },
    token: null,
    code: `# MCP tools/call with HTTP Basic auth (creds from the secret/service account)\ncurl -X POST '<mcp-endpoint>/tools/call' \\\n  -u '${creds?.username || '<username>'}:<password>' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ name: toolName, arguments: {} })}'`,
  };
}

export function summarize(toolName, result) {
  if (toolName === 'get_inventory_details') {
    const low = result.items.filter((i) => i.quantity <= i.reorderLevel);
    const lines = result.items.map((i) => `• ${i.name} (${i.sku}) — ${i.quantity} in stock @ ${i.location}`);
    let answer = `Here are the current inventory details (${result.count} SKUs):\n\n${lines.join('\n')}`;
    if (low.length) {
      answer += `\n\n⚠️ ${low.length} item(s) at or below reorder level: ${low.map((i) => i.sku).join(', ')}.`;
    }
    return answer;
  }
  if (toolName === 'get_last_5_shipments') {
    const lines = result.shipments.map(
      (s) => `• ${s.id} — ${s.status} via ${s.carrier} → ${s.destination} (${s.items} items, ${s.date})`
    );
    return `Here are the last ${result.count} shipments:\n\n${lines.join('\n')}`;
  }
  if (toolName === 'get_customer_arr') {
    const lines = result.customers.map(
      (c) => `• ${c.customer} (${c.segment}) — $${c.arr.toLocaleString()} ARR, renews ${c.renewalDate} [${c.health}]`
    );
    return `Customer ARR (${result.count}):\n\n${lines.join('\n')}`;
  }
  if (toolName === 'get_customer_payment_details') {
    const lines = result.payments.map(
      (p) => `• ${p.customer} — ${p.invoice}: $${p.amount.toLocaleString()} ${p.status} via ${p.method} (${p.date})`
    );
    return `Customer payment details (${result.count}):\n\n${lines.join('\n')}`;
  }
  return JSON.stringify(result, null, 2);
}
