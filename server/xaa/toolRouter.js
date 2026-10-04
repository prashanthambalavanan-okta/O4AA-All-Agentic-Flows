// Deterministic question → MCP tool routing, shared by the chat route (/api/ask) and
// the step-by-step runner (which uses the allow-lists to populate its tool dropdown).

// Deterministic routing of a question to an MCP tool.
export function routeTool(question) {
  const q = (question || '').toLowerCase();
  if (q.includes('shipment') || q.includes('shipping') || q.includes('delivery')) {
    return 'get_last_5_shipments';
  }
  // inventory / stock / default
  return 'get_inventory_details';
}

// Finance (A2A) tool routing.
export function routeFinanceTool(question) {
  const q = (question || '').toLowerCase();
  if (q.includes('payment') || q.includes('invoice') || q.includes('billing')) {
    return 'get_customer_payment_details';
  }
  return 'get_customer_arr';
}

// The tools each router can select — the runner offers these as a dropdown.
export const INVENTORY_TOOLS = ['get_inventory_details', 'get_last_5_shipments'];
export const FINANCE_TOOLS = ['get_customer_arr', 'get_customer_payment_details'];
