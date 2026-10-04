# O4AA — All Agentic Flows (Okta for AI Agents)

A self-contained demo of **Okta AI-agent token-exchange** patterns. A user signs into a chat app
with Okta, picks a use case, and an "agent" runs the corresponding token chain to reach a protected
resource. **Every API call in the chain is rendered as a step** with **Request / Response / Token /
Code** tabs — so you can watch the exact requests, decoded JWTs, and responses, one step at a time.

The visualization is the point: a top stepper (T1, T2, T3, …) with per-step cards that show the
method + URL, headers (collapsible), the form/JSON body, decoded JWT parameters, the issued token,
and a copy-paste `curl` snippet.

## Use cases

The home page offers five flows. All run against **real Okta** (no mock mode).

| Flow | Steps | What it demonstrates |
|------|-------|----------------------|
| **Cross-App Access** | T1 login → T2 **id-JAG** → T3 **access token** → T4 **MCP** | Identity Assertion Authorization Grant: exchange the user's `id_token` for an id-JAG, then a resource access token, then call a token-validated MCP tool. |
| **Secrets** | T1 login → T2 **vaulted secret** → T3 **MCP (Basic)** | Exchange the user's `id_token` for a vaulted secret (Okta Privileged Access), then call the MCP with HTTP Basic auth using the retrieved credentials. |
| **Service Accounts** | T1 login → T2 **service account** → T3 **MCP (Basic)** | Exchange for a service-account username/password, then call the MCP with HTTP Basic auth. |
| **NHI - Okta Protected Resource** | T1 **client_credentials** → T2 **id-JAG** → T3 **access token** → T4 **MCP** | A non-human/service identity: a headless app authenticates with `private_key_jwt` (client credentials), then runs the XAA chain — no user involved. |
| **STS Broker (GitHub)** | T1 login → T2 **brokered token** (consent loop) → T3 **read / create PR** | Exchange for an Okta-brokered GitHub token. If consent is needed Okta returns `interaction_required` → authorize → retry. Then read or create a pull request. Includes a **Revoke** action to re-trigger consent. |

### Auth at a glance

- **T1 login** — OIDC Authorization Code + PKCE. The chat app is a **confidential client with no
  secret**: it authenticates at `/token` with `private_key_jwt` (RFC 7523 §2.2), signed with the
  **same** RSA key the agent uses — so there is exactly **one** keypair and one public JWK in the
  whole project. Same for the A2A login app.
- **id-JAG / access-token / vaulted exchanges** — `private_key_jwt` client assertions (RFC 7523),
  signed with the **agent** RSA key. In the XAA flow the T3 jwt-bearer call authenticates with
  `client_id` + agent assertion; the MCP access token is **verified** at T4 (JWKS signature + issuer
  + expiry + required scope).
- **Secrets / Service Accounts** — token-exchange at the **org** token endpoint
  (`requested_token_type` = `vaulted-secret` / `service-account`); the returned username/password are
  used as **HTTP Basic** to the MCP, validated against `MCP_BASIC_*`.
- **NHI flow** — `client_credentials` (service cert) for the service token; T2/T3 assertions use the
  **agent** identity (`iss`/`sub` = `AGENT_CLIENT_ID`, signed with the agent key).
- **STS Broker** — token-exchange `requested_token_type` = `oauth-sts`; on `interaction_required` the
  UI surfaces the `interaction_uri`. Revoke uses RFC 7009 (`token_type_hint=oauth_sts`,
  agent `private_key_jwt`, `aud` = the revoke endpoint).

## Architecture

```
O4AA-All-Agentic-Flows/
  server/                      # Express API (port 8080)
    index.js                   # app wiring, session, serves client/dist in prod
    config.js                  # env loading + endpoint derivation + validation
    auth/oidc.js               # OIDC login (openid-client, PKCE, private_key_jwt) — builds the T1 step
    routes/ask.js              # POST /api/ask (flow router) + POST /api/sts/revoke
    xaa/
      clientAssertion.js       # private_key_jwt builders (agent + service certs, multi-key)
      capture.js               # instrumented fetch -> captured step (form / JSON / GET)
      tokenExchange.js         # XAA: requestIdJag (T2) + exchangeForAccessToken (T3)
      credentialExchange.js    # Secrets + Service Account (T2 vaulted creds)
      serviceFlow.js           # NHI: client_credentials (T1) + id-JAG (T2) + access token (T3)
      stsBroker.js             # STS: resource token (T2), read/create PR (T3), revoke
    mcp/
      inventoryServer.js       # in-process MCP server (SDK) — get_inventory_details, get_last_5_shipments
      data.js                  # static inventory + shipment data
    util/
      jwt.js                   # display-only JWT decode
      privateKey.js            # shared PEM loader + private JWKS (login apps + assertions)
      verifyToken.js           # JWKS signature + issuer + scope validation (T4)
  client/                      # React + Vite (dev port 5173, proxies /api -> 8080)
    src/
      App.jsx flows.js api.js
      components/Home.jsx Chat.jsx SequenceView.jsx StepCard.jsx
                 TokenView.jsx JsonView.jsx CodeBlock.jsx Login.jsx
      decodeJwt.js paramGlossary.js   # in-browser JWT decode + per-param explanations
  scripts/agent-key.mjs        # inspect or generate the agent signing key (prints public JWK)
  keys/                        # gitignored; drop agent.pem / service.pem here
  .env.example                 # all config, copy to .env
```

## Setup

```sh
npm install                # server deps
npm run client:install     # client deps (React + Vite)
cp .env.example .env        # then fill in your Okta values
```

### Signing keys

The **login web apps**, the agent, and (for the NHI flow) the service app all authenticate with
`private_key_jwt`, so they need RSA private keys whose **public JWKs are registered in Okta**.

There is only **one application key**: the login apps reuse `keys/agent.pem` / `AGENT_KID` by
default, so the same public JWK is registered on the chat app, the A2A app, and the agent app.

```sh
# Generate the agent key + print the public JWK to register in Okta (and the kid):
node scripts/agent-key.mjs --generate

# Or inspect the public JWK of an existing keys/agent.pem (read-only):
node scripts/agent-key.mjs
```

Drop the private keys at `keys/agent.pem` and (for NHI) `keys/service.pem`; set `AGENT_KID` /
`SERVICE_KID` to the registered JWK `kid`. PKCS#8 and PKCS#1 PEMs are both accepted.

If you'd rather give a login app its own key, set `OKTA_PRIVATE_KEY_FILE` / `OKTA_KID` (or the
`A2A_OKTA_*` equivalents) — otherwise leave them unset.

### Okta prerequisites

- **Chat app** — OIDC web app for user login (redirect `…/api/callback`). Set **General → Client
  Credentials → Client authentication = "Public key / Private key"**, then **Add key** and paste the
  public JWK from `node scripts/agent-key.mjs`. No client secret is stored anywhere. Do the same for
  the **A2A app** (redirect `…/api/a2a/callback`).
- **Agent app** — registered with the same agent public key; enabled for `token-exchange`.
- **Resource client + authorization server** — the id-JAG's `client_id` must match
  `AGENT_CLIENT_ID` (T3 authenticates as the agent); the T2 token-exchange `audience` is `RESOURCE_AUTH_SERVER`.
- **Secrets / Service Accounts** — configured Resource Connections; `*_RESOURCE` ORNs.
- **STS Broker** — a GitHub Resource Connection; the backing GitHub App needs **Pull requests:
  read** (read) or **read & write** (create).

## Configuration (`.env`)

Auth-server **URLs** are configured; `/v1/token`, `/v1/keys`, and `/v1/revoke` endpoints are derived
automatically (handles both org `…/oauth2/v1/…` and custom `…/oauth2/<id>/v1/…` servers). `config.js`
validates the required vars and prints exactly which is missing.

| Group | Key vars |
|-------|----------|
| App / login (T1) | `OKTA_ISSUER`, `OKTA_CLIENT_ID`, `OKTA_REDIRECT_URI`, `SESSION_SECRET` — no secret; signs with `AGENT_PRIVATE_KEY_FILE`/`AGENT_KID` unless `OKTA_PRIVATE_KEY_FILE`/`OKTA_KID` are set |
| Agent (XAA T2) | `AGENT_AUTH_SERVER`, `AGENT_CLIENT_ID`, `AGENT_PRIVATE_KEY_FILE`, `AGENT_KID`, `XAA_RESOURCE` |
| Resource (XAA T3 + T4 validation) | `RESOURCE_AUTH_SERVER` (also the T2 audience), `RESOURCE_SCOPES` (T3 auth uses `AGENT_CLIENT_ID`) |
| HI - SAML (agent identity) | `AGENT_CLIENT_ID_SAML` — dedicated agent client_id for this flow's T2–T4 mint/redeem, signed with the same `AGENT_PRIVATE_KEY_FILE`/`AGENT_KID`; falls back to `AGENT_CLIENT_ID` if unset |
| HI - Cross-App Access (Login as Web App) | `WEBAPP_CLIENT_ID`, `WEBAPP_CLIENT_SECRET`, `WEBAPP_REDIRECT_URI`, `WEBAPP_RESOURCE` (client_secret auth, separate app from `OKTA_CLIENT_ID`) |
| Secrets / Service Accounts | `SECRETS_RESOURCE`, `SERVICE_ACCOUNT_RESOURCE`, `MCP_BASIC_USERNAME`, `MCP_BASIC_PASSWORD` (`OKTA_ORG_URL` optional) |
| NHI / Service App | `SERVICE_CLIENT_ID`, `SERVICE_PRIVATE_KEY_FILE`, `SERVICE_KID`, `SERVICE_SCOPES`, `SERVICE_IDJAG_SCOPES`, `SERVICE_ISSUER`, `SERVICE_AUDIENCE`, `SERVICE_RESOURCE` |
| STS Broker (GitHub) | `GITHUB_RESOURCE`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_PR_BASE`, `GITHUB_PR_HEAD`, `GITHUB_PR_TITLE` |

See `.env.example` for the full, commented list.

## Run

```sh
npm run dev      # server (nodemon) on :8080 + Vite UI on :5173 (hot-reload)
```

Open **http://localhost:5173**, sign in with Okta, pick a flow, and click a suggestion.

Production-style single port:

```sh
npm run build    # builds client into client/dist
npm start        # Express serves the API + built client on :8080
```

> When using `npm start`, source changes require a rebuild (`npm run build`). Use `npm run dev`
> during development to avoid that.

## Verifying / demoing

- Open any flow → click a suggestion → step through **T1…Tn**; on each card check
  **Request / Response / Token / Code**, expand **HEADERS** and **DECODED JWT PARAMETERS**, and read
  **PARAMETER REFERENCE** for what each request parameter means.
- **XAA / NHI**: the T4 card shows the access token decoded and the resource-server validation result
  (signature, issuer, scopes). Insufficient scope → 403 in T4.
- **STS Broker**: first attempt may return **`interaction_required`** → click **Authorize
  connection** → consent in Okta → **Retry**. Then **Read** (GET) or **Create** (POST) a pull
  request. **Create** is a write call, so it genuinely proves the brokered token works. Use **Revoke
  STS token** to clear Okta's stored token and re-trigger consent.

## Notes

- **Real Okta only.** Nothing works until `.env` is filled; failed Okta/GitHub calls render their
  error response in the step's **Response** tab, which is itself useful for debugging.
- Tokens are shown in the UI for learning; the GitHub Bearer token is masked in the displayed request.
- The MCP server is hosted **in-process** (MCP SDK over an in-memory transport), not a separate port.
- Secrets are never committed: `.env` and `keys/*.pem` are gitignored.


gh auth login 
gh repo create O4AA-Agent-Flows --private --source=. --remote=origin --push
git add … && git commit -m "…"   
git push