const INVENTORY_SUGGESTIONS = [
  { label: 'Get inventory details', text: 'Get inventory details' },
  { label: 'Show last 5 shipments', text: 'Show me the last 5 shipments' },
];

// The AI-agent token-exchange use cases the demo walks through.
export const FLOWS = {
  xaa: {
    id: 'xaa',
    name: 'HI - Cross-App Access (Login as agent)',
    cardSuffix: '(Login as agent)',
    note: 'Using subject id_token',
    tagline: 'Agent → id-JAG → Resource Access Token → Protected MCP',
    description:
      'Exchange the user’s ID token for an Identity Assertion Authorization Grant, then for a resource access token, and call the inventory MCP',
    accent: '#16c784',
    suggestions: INVENTORY_SUGGESTIONS,
  },
  'xaa-webapp': {
    id: 'xaa-webapp',
    name: 'HI - Cross-App Access (Login as Web App)',
    cardSuffix: '(Login as Web App)',
    note: 'Using subject access_token',
    tagline: 'Web App → id-JAG → Resource Access Token → Protected MCP',
    description:
      'The user signs in to a separate web app and gets a token with agent resource parameter. Its ACCESS token is the subject of the id-JAG exchange, then a resource access token calls the inventory MCP.',
    accent: '#22d3ee',
    authContext: 'webapp',
    suggestions: INVENTORY_SUGGESTIONS,
  },
  'hi-saml': {
    id: 'hi-saml',
    name: 'HI - SAML - Cross-App Access',
    tagline: 'SAML SSO → Refresh Token → id-JAG → Resource Access Token → Protected MCP',
    description:
      'The user signs in with a SAML app (IdP-initiated); Okta posts the assertion to the agent. The agent exchanges the SAML assertion for a refresh token, the refresh token for an id-JAG, then a resource access token, and calls the inventory MCP.',
    accent: '#ec4899',
    authContext: 'saml',
    suggestions: INVENTORY_SUGGESTIONS,
  },
  secrets: {
    id: 'secrets',
    name: 'HI - Secrets',
    tagline: 'Agent → Vaulted Secret → Protected MCP',
    description:
      'Exchange the user’s ID token for a vaulted secret from Okta Privileged Access, then call the inventory MCP using HTTP Basic authentication with the retrieved credentials.',
    accent: '#3b82f6',
    suggestions: INVENTORY_SUGGESTIONS,
  },
  'secrets-atlassian': {
    id: 'secrets-atlassian',
    name: 'NHI - Secrets (Atlassian id/secret from OPA)',
    warning: 'Not recommended (Secrets exposed to agent)',
    tagline: 'Service App → Agent → Vaulted Atlassian id/secret → Atlassian Token → Jira Scrum Board',
    description:
      'A service app gets a client_credentials token, the agent swaps it for the Atlassian client id/secret in the Okta vault, then reads the Jira Scrum board (read-only).',
    accent: '#0052cc',
    resourceParty: '3P',
    // No user-login step — this flow runs on the service identity.
    prependLogin: false,
    suggestions: [
      { label: 'Get Scrum board tasks', text: 'Get Scrum board tasks' },
    ],
    scheduler: {
      badge: 'NHI · NO HUMAN LOGIN',
      title: 'Scheduled Task',
      blurb:
        'The same NHI - Secrets (Atlassian id/secret from OPA) chain as the chat demo, kicked off by a scheduler instead of a question. This page and its endpoint are unauthenticated — the only identity on the wire is the service app’s, via client_credentials + private_key_jwt.',
      toolLabel: 'Atlassian task',
      tools: [{ value: 'get_scrum_board_tasks', label: 'Scrum board tasks' }],
    },
  },
  'secrets-atlassian-token': {
    id: 'secrets-atlassian-token',
    name: 'NHI - Secrets (Atlassian token from OPA)',
    recommended: 'Recommended (workflow sets token in Vault)',
    tagline: 'Service App → Agent → Vaulted Atlassian Token → Jira Scrum Board',
    description:
      'A service app gets a client_credentials token, the agent swaps it for the Atlassian access token stored in the Okta vault, then reads the Jira Scrum board (read-only). ',
    accent: '#0747a6',
    resourceParty: '3P',
    // No user-login step — this flow runs on the service identity.
    prependLogin: false,
    suggestions: [
      { label: 'Get Scrum board tasks', text: 'Get Scrum board tasks' },
    ],
    scheduler: {
      badge: 'NHI · NO HUMAN LOGIN',
      title: 'Scheduled Task',
      blurb:
        'The same NHI - Secrets (Atlassian token from OPA) chain as the chat demo, kicked off by a scheduler instead of a question. This page and its endpoint are unauthenticated — the only identity on the wire is the service app’s, via client_credentials + private_key_jwt.',
      toolLabel: 'Atlassian task',
      tools: [{ value: 'get_scrum_board_tasks', label: 'Scrum board tasks' }],
    },
  },
  'service-account': {
    id: 'service-account',
    name: 'HI - Service Accounts',
    tagline: 'Agent → Service Account Creds → Protected MCP',
    description:
      'Exchange the user’s ID token for a service account username/password, then call the inventory MCP using HTTP Basic authentication with those credentials.',
    accent: '#a855f7',
    suggestions: INVENTORY_SUGGESTIONS,
  },
  'client-credentials': {
    id: 'client-credentials',
    name: 'NHI - Okta Protected Resource',
    tagline: 'Client-credentials → id-JAG → Resource Access Token → Protected MCP',
    description:
      'A service app authenticates with private_key_jwt (client_credentials), then exchanges its service token for an id-JAG and a resource access token',
    accent: '#f59e0b',
    // No user-login step in the sequence — this flow uses a service identity.
    prependLogin: false,
    suggestions: INVENTORY_SUGGESTIONS,
    scheduler: {
      badge: 'NHI · NO HUMAN LOGIN',
      title: 'Scheduled Task',
      blurb:
        'The same NHI - Okta Protected Resource chain as the chat demo, kicked off by a scheduler instead of a question. This page and its endpoint are unauthenticated — the only identity on the wire is the service app’s, via client_credentials + private_key_jwt.',
      toolLabel: 'Inventory tool',
      tools: [
        { value: 'get_inventory_details', label: 'Inventory details' },
        { value: 'get_last_5_shipments', label: 'Last 5 shipments' },
      ],
    },
  },
  'hi-a2a': {
    id: 'hi-a2a',
    name: 'HI - A2A',
    tagline: 'User → Inventory Agent → Finance Agent → Finance MCP',
    description:
      'Agent-to-agent on the user’s behalf: id-JAGs are minted at the Org auth server. The Inventory Agent gets its token, then requests an id-JAG for the Finance Agent, which gets its own access token and calls the finance MCP.',
    accent: '#0ea5e9',
    authContext: 'a2a',
    suggestions: [
      { label: 'Get Customer ARR', text: 'Get customer ARR' },
      { label: 'Get Customer Payments', text: 'Get customer payments' },
    ],
  },
  'nhi-a2a': {
    id: 'nhi-a2a',
    name: 'NHI - A2A - Okta Protected Resource',
    tagline: 'service app → Inventory Agent → Finance Agent → Finance MCP',
    description:
      'Agent-to-agent with a non-human identity: a service app gets a token via client_credentials, then runs the same Inventory Agent → (Org id-JAG) → Finance Agent chain to call the finance MCP.',
    accent: '#14b8a6',
    // No user or A2A login step — this flow runs entirely on the service identity.
    prependLogin: false,
    suggestions: [
      { label: 'Get Customer ARR', text: 'Get customer ARR' },
      { label: 'Get Customer Payments', text: 'Get customer payments' },
    ],
    scheduler: {
      badge: 'NHI · NO HUMAN LOGIN',
      title: 'Scheduled Agent-to-Agent',
      blurb:
        'The same NHI - A2A - Okta Protected Resource chain as the chat demo, kicked off by a scheduler instead of a question. This page and its endpoint are unauthenticated — the only identity on the wire is the service app’s, via client_credentials + private_key_jwt.',
      toolLabel: 'Finance tool',
      tools: [
        { value: 'get_customer_arr', label: 'Customer ARR' },
        { value: 'get_customer_payment_details', label: 'Customer Payments' },
      ],
    },
  },
  'sts-github': {
    id: 'sts-github',
    name: 'HI - STS Broker (GitHub)',
    tagline: 'Agent → STS Brokered Consent → Resource Token → Protected GitHub Resource',
    description:
      'Exchange the user’s ID token for a GitHub access token brokered by Okta. If consent is needed, Okta returns interaction_required — authorize, then retry — and the agent reads the repository’s pull requests with the brokered token.',
    accent: '#6e40c9',
    // GitHub is an external provider, so the resource the agent reaches is third-party.
    resourceParty: '3P',
    suggestions: [
      { label: 'Read pull requests', text: 'Read pull requests' },
      { label: 'Create a pull request', text: 'Create a pull request' },
    ],
    stsRevoke: true,
    greeting: 'Click “Read pull requests” or “Create a pull request” to start.',
    placeholder: 'Ask the agent to read pull requests…',
  },
  'sts-atlassian': {
    id: 'sts-atlassian',
    name: 'HI - STS Broker (Atlassian)',
    tagline: 'Agent → STS Brokered Consent → Resource Token → Atlassian MCP (Jira)',
    description:
      'Exchange the user’s ID token for an Atlassian access token brokered by Okta. If consent is needed, Okta returns interaction_required — authorize, then retry — and the agent calls Atlassian’s MCP server with the brokered token to read and create Jira tickets.',
    accent: '#0052cc',
    // Atlassian is an external provider, so the resource the agent reaches is third-party.
    resourceParty: '3P',
    suggestions: [
      { label: 'Read Jira tickets', text: 'Read Jira tickets' },
      { label: 'Create a Jira ticket', text: 'Create a new Jira ticket' },
    ],
    stsRevoke: true,
    greeting: 'Click “Read Jira tickets” or “Create a Jira ticket” to start.',
    placeholder: 'Ask the agent to read or create Jira tickets…',
  },
};

// ── Authentication Patterns ──
// Four agents, one per client-authentication method. Every one runs the same
// "HI - Cross-App Access (Login as agent)" chain: the agent is the OIDC client
// (T0/T1), then T2 id-JAG and T3 resource token — all authenticated the same way.
const authPattern = (pattern, fields) => ({
  id: `authp-${pattern}`,
  authContext: 'authp',
  authPattern: pattern,
  note: 'Login as agent · subject id_token',
  // These cards compare client authentication, not agent/resource ownership.
  hideParties: true,
  suggestions: INVENTORY_SUGGESTIONS,
  ...fields,
});

export const AUTH_PATTERN_FLOWS = {
  'authp-pkjwt': authPattern('pkjwt', {
    name: 'Public / Private Key',
    tagline: 'private_key_jwt → id-JAG → Resource Access Token → Protected MCP',
    description:
      'The agent proves its identity at every /token call with a short-lived JWT signed by its private key. Okta verifies it against the public JWK registered on the agent — no shared secret exists anywhere.',
    accent: '#16c784',
    usage: {
      label: 'Confidential agents',
      examples: 'Backend services, cloud-hosted agents, keys in KMS / HSM / vault',
    },
  }),
  'authp-secret': authPattern('secret', {
    name: 'Client ID / Client Secret',
    tagline: 'client_secret_basic → id-JAG → Resource Access Token → Protected MCP',
    description:
      'The agent authenticates with a client ID and a shared client secret (HTTP Basic). Simple, but the secret is a long-lived bearer credential that must be stored, rotated and protected.',
    accent: '#f59e0b',
    usage: {
      label: 'Confidential agents (shared secret)',
      examples: 'Internal tools, prototypes, platforms that only support client secrets',
    },
  }),
  'authp-public': authPattern('public', {
    name: 'Client ID Only',
    tagline: 'client_id (public client) → id-JAG → Resource Access Token → Protected MCP',
    description:
      'A public client: the agent sends only its client_id — PKCE protects the authorization code, but nothing proves which software is calling at /token.',
    accent: '#ef4444',
    usage: {
      label: 'Public agents',
      examples: 'Desktop / CLI agents, local MCP clients, browser extensions, mobile apps',
    },
  }),
  'authp-cimd': authPattern('cimd', {
    name: 'CIMD (Client ID Metadata Document)',
    tagline: 'client_id = metadata URL → id-JAG → Resource Access Token → Protected MCP',
    description:
      'The client_id is an HTTPS URL to a JSON document this app hosts. Okta fetches it to learn the agent’s redirect URIs and its jwks_uri, then verifies the agent’s private_key_jwt — no pre-registered keys.',
    accent: '#8b5cf6',
    usage: {
      label: 'Open-ecosystem agents',
      examples: 'Third-party MCP clients and AI apps not pre-registered in Okta',
    },
  }),
};
Object.assign(FLOWS, AUTH_PATTERN_FLOWS);

export const FLOW_LIST = Object.values(FLOWS);
