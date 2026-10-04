# O4AA Sales Demo Script & Talk Track

**Product:** Okta for AI Agents (O4AA) — Cross-App Access, Secrets, Service Accounts, A2A, and STS Broker
**Audience:** Prospect/customer technical + security buyers evaluating how to govern AI agents' access to systems
**Environment:** `npm run dev` → http://localhost:5173, real Okta org (no mock mode)

*Tip: In Google Docs, enable Tools → Preferences → "Automatically detect Markdown" before pasting this in — headers, bold, and bullets will convert automatically.*

---

## 0. Before you go live

- Confirm `.env` is filled and `npm run dev` is running — server on 8080, client on 5173
- Sign out of Okta in the demo browser first, so the login step is visible (or use an incognito window)
- Pick your **running order** based on time available (see below)
- Know your audience's pain point going in — it changes which flow you lead with:
  - "How do we let an AI agent call our APIs without minting API keys everywhere?" → lead with **HI - Cross-App Access**
  - "We have secrets/passwords hardcoded in agent config today" → lead with **Secrets**
  - "We're worried about long-lived service account creds for bots/agents" → lead with **Service Accounts** or **NHI - Okta Protected Resource**
  - "Agents will talk to other agents — how do we scope that?" → lead with **HI - A2A** / **NHI - A2A**
  - "Agents need to act on GitHub/Slack/SaaS on the user's behalf" → lead with **STS Broker (GitHub)**
  - "We're a SAML shop, OIDC is the exception not the rule" → lead with **HI - SAML - Cross-App Access**

### Timing options

- **Elevator (10 min):** HI - Cross-App Access → STS Broker (GitHub)
- **Standard (20 min):** HI - Cross-App Access → Secrets → NHI - Okta Protected Resource → HI - A2A → STS Broker (GitHub)
- **Full technical deep-dive (35–40 min):** All 9 flows, in the order below

---

## The core narrative (say this before touching the keyboard)

"Every one of these flows answers the same question: **when an AI agent needs to reach a protected resource, what identity is on the wire, and who governed that?** We're not going to tell you about it — every single API call the agent makes is going to render live on screen, with the actual request, the actual response, and the actual decoded token. Nothing here is mocked. This is a real Okta org."

---

## Flow 1 — HI - Cross-App Access (Login as agent)

**Use case:** The flagship pattern — a user signs into a chat/agent app, and the agent needs to reach a *different* protected resource (an MCP-exposed inventory system) **as that user**, without ever holding a password or a long-lived API key for that resource.

**Time:** 5 min

**Token to point at:** The **id-JAG** (Identity Assertion Authorization Grant) at T2 — this is the "aha" token. Call out that it's minted from the user's `id_token`, not a shared secret.

**Setup:** Click **HI - Cross-App Access (Login as agent)** → sign in with Okta → type suggestion "Get inventory details".

**Talk track:**

- **T1 (login):** "This is standard OIDC Authorization Code + PKCE — nothing new here. What *is* new: this app has no client secret. It authenticates with `private_key_jwt` — a signed assertion, same keypair the agent uses downstream. One fewer secret to leak."
- **T2 (id-JAG):** "Here's the moment. The agent takes the user's `id_token` and exchanges it — at Okta — for an Identity Assertion Authorization Grant. This is an emerging standard for saying 'this agent is acting on behalf of this specific user, for this specific resource.' Look at the decoded JWT: you can see exactly whose identity is being asserted and to which audience."
- **T3 (access token):** "The id-JAG gets exchanged again, this time for a real OAuth access token scoped to the resource — the inventory MCP server. Two exchanges, two audit points, zero passwords."
- **T4 (MCP call):** "Now the agent calls the MCP tool. Watch — the resource server independently validates this token: signature against Okta's JWKS, issuer, expiry, and required scope. If any of those fail, it's a 403, not a silent bypass."

**Close line:** "So the agent never saw a password, never held a static API key, and every hop is a token Okta issued and can revoke."

---

## Flow 2 — HI - Cross-App Access (Login as Web App)

**Use case:** Same outcome as Flow 1, but for customers whose user-facing app is a traditional confidential web app (client_secret auth) rather than a `private_key_jwt` client — shows XAA isn't locked to one auth style.

**Time:** 2–3 min (skip in the 10-min version)

**Token to point at:** The subject is the web app's **access_token** (not `id_token` like Flow 1) — flag this difference explicitly, it's a common technical question.

**Setup:** Click **HI - Cross-App Access (Login as Web App)** → sign in → "Show me the last 5 shipments".

**Talk track:**

- "Same destination, different starting point. This web app logged in with `client_secret` — completely standard — and its `/authorize` call carried a `resource` parameter. That means the subject token for the id-JAG exchange is this app's **access token**, not an ID token. If your app already does OIDC the boring way, this pattern still works unchanged."

**Close line:** "The point: Cross-App Access adapts to how you already authenticate — it doesn't force a rip-and-replace of your login flow."

---

## Flow 3 — HI - SAML - Cross-App Access

**Use case:** For SAML-first enterprises — proves Cross-App Access isn't an OIDC-only story.

**Time:** 3 min (only include if the prospect is SAML-heavy)

**Token to point at:** The **refresh token** minted from the SAML assertion at T2 — this is the bridge step most people don't expect.

**Setup:** Click **HI - SAML - Cross-App Access** → SAML IdP-initiated login → suggestion.

**Talk track:**

- "Your workforce logs in via SAML today — that's not going away. Watch: Okta posts the SAML assertion to the agent, the agent exchanges *that* for an OAuth refresh token, and from there it's the exact same chain you just saw — refresh token → id-JAG → resource access token → MCP call."

**Close line:** "SAML on the front door, modern token exchange on the back end — you don't have to migrate your IdP integration to adopt this."

---

## Flow 4 — Secrets

**Use case:** Replacing "the agent has a vault password baked into its config" with governed, on-demand secret retrieval — targets Okta Privileged Access customers or anyone with credential sprawl in agent tooling.

**Time:** 3 min

**Token to point at:** The **vaulted secret** at T2 — emphasize it's fetched just-in-time, not stored anywhere in the agent's config or environment.

**Setup:** Click **Secrets** → sign in → "Get inventory details".

**Talk track:**

- **T1:** "Same login as before."
- **T2 (vaulted secret):** "This is the difference. The agent exchanges the user's ID token for a secret that's *vaulted* in Okta Privileged Access — pulled just-in-time, not sitting in a `.env` file or a config map somewhere."
- **T3 (MCP, Basic auth):** "The agent uses that retrieved credential as HTTP Basic auth to call the MCP. If you rotate or revoke the vaulted secret in Okta, this call fails on the very next request — no redeploy needed."

**Close line:** "If your security team's nightmare is 'which of our forty agent configs has a stale password in it' — this is the answer."

---

## Flow 5 — Service Accounts

**Use case:** Same problem as Secrets, different shape — for systems that specifically expect a service-account username/password rather than a vaulted arbitrary secret.

**Time:** 2 min

**Token to point at:** The **service-account username/password pair** at T2, issued via token-exchange rather than provisioned by hand.

**Setup:** Click **Service Accounts** → sign in → suggestion.

**Talk track:**

- "Functionally identical to Secrets, but instead of an arbitrary vaulted value, Okta issues a proper service-account credential pair on exchange. Same governance story: centrally issued, centrally revocable, no manual provisioning ticket."

**Close line:** "This is the pattern for 'the target system only speaks basic auth and we can't change that.'"

---

## Flow 6 — NHI - Okta Protected Resource

**Use case:** The **machine-to-machine** version of Flow 1 — no human ever logs in. This is the one to show anyone worried about "shadow" non-human identities running scheduled agent jobs.

**Time:** 3 min

**Token to point at:** There's no `id_token` at all here — start from the **client_credentials service token**, then the same id-JAG → access-token chain. Explicitly say "no human identity touched this."

**Setup:** Click **NHI - Okta Protected Resource** → suggestion (no login step — call this out before clicking).

**Talk track:**

- "Notice there's no login screen. This flow represents a scheduled job, a headless service — something that runs at 2am with nobody at a keyboard. It authenticates with `private_key_jwt` via `client_credentials` — a signed cert-backed assertion, not a static shared secret — and from there it's the *identical* id-JAG → access-token → MCP chain you already saw for a human user."
- If you have time, show the **scheduler page**: "This is the same chain, but kicked off by a scheduler UI instead of a chat prompt — the only identity on the wire, end to end, is the service app's."

**Close line:** "Same governance model for your bots as for your people — one control plane, not a spreadsheet of API keys."

---

## Flow 7 — HI - A2A

**Use case:** Agent-to-agent delegation on a user's behalf — the Inventory Agent needs data that actually lives behind the Finance Agent. Shows Okta governing *agent-to-agent* trust, not just agent-to-resource.

**Time:** 4 min

**Token to point at:** The **second id-JAG** — minted for the Finance Agent, at the Org auth server, on top of the first agent's own token. This is the layered-delegation moment.

**Setup:** Click **HI - A2A** → sign in → "Get customer ARR".

**Talk track:**

- "The user asks the Inventory Agent for ARR — but ARR lives in Finance's system, not Inventory's. Watch what happens: the Inventory Agent gets its own token first, then it turns around and requests an id-JAG *for the Finance Agent*, on the user's behalf, at the Org auth server. The Finance Agent gets its own scoped access token and calls the finance MCP."
- "Every hop still names the original user as the subject — nothing gets laundered into an anonymous service call along the way."

**Close line:** "This is the pattern that scales past one agent — a chain of agents delegating to each other, and Okta is the thing that keeps the user's identity attached at every hop."

---

## Flow 8 — NHI - A2A

**Use case:** Same agent-to-agent delegation as Flow 7, but entirely machine-driven — no user in the loop at all.

**Time:** 2 min

**Token to point at:** Same layered id-JAG pattern as Flow 7, but rooted in a `client_credentials` service token instead of a user login.

**Setup:** Click **NHI - A2A** → suggestion (no login).

**Talk track:**

- "Take the delegation pattern you just saw and remove the human entirely — a service app authenticates via `client_credentials`, and the same Inventory Agent → Finance Agent chain runs unattended. Same audit trail, same scoping, zero human identity involved."

**Close line:** "Whether it's a person or a cron job kicking things off, the delegation chain — and the governance over it — doesn't change."

---

## Flow 9 — STS Broker (GitHub) — the closer

**Use case:** The agent needs to act on a **third-party SaaS** (GitHub) on the user's behalf — read or *write* (create a PR) — without the agent ever holding a GitHub PAT. This is usually the most visually convincing flow because it ends in a real, live pull request.

**Time:** 5 min

**Token to point at:** The **Okta-brokered GitHub access token** at T2 — and the `interaction_required` consent loop if this is the first run.

**Setup:** Click **STS Broker (GitHub)** → sign in → "Read pull requests", then "Create a pull request".

**Talk track:**

- **T1:** "Standard login."
- **T2 (brokered token, first run):** "Watch — Okta comes back with `interaction_required`. That's Okta telling us: this user hasn't consented to let this agent touch their GitHub account yet. We click **Authorize connection**, consent once in Okta, and retry — now Okta hands back a GitHub access token it's brokering on the user's behalf."
- **T3 (read):** "Read pull requests — straightforward, proves the token works."
- **T3 (create):** "Now the real proof: **create a pull request**. This is a write call. If this token weren't real and scoped correctly, this fails outright — there's no faking this one." *(Open the actual PR in GitHub in a second tab if you want the visual payoff.)*
- **Revoke:** "And if you want to see governance in action: click **Revoke STS token**. That clears Okta's stored grant. Ask for a PR again — you're back to `interaction_required`. The access is gone the moment you say it's gone."

**Close line:** "The agent never had a GitHub personal access token sitting in an env var somewhere. Okta brokered it, scoped it, and can kill it — instantly, centrally — for every agent that was using it."

---

## Wrap-up (say this at the end, every time)

"Nine different shapes of 'an AI agent needs to reach something' — human-initiated, machine-initiated, single-hop, multi-agent, first-party, third-party. In every single one, the pattern is the same: **short-lived, purpose-bound, centrally revocable tokens instead of standing credentials** — and you just watched every request and every decoded token happen in real time, against a real Okta org. Nothing here was mocked, and nothing here is Okta-proprietary plumbing you can't inspect — it's RFC 7523 `private_key_jwt`, RFC 7009 revocation, and the emerging Identity Assertion Authorization Grant spec."

---

## Quick-reference summary

- **HI - Cross-App Access (Login as agent)** — 5 min — token: id-JAG (from `id_token`) — human login: yes
- **HI - Cross-App Access (Login as Web App)** — 2–3 min — token: id-JAG (from `access_token`) — human login: yes
- **HI - SAML - Cross-App Access** — 3 min — token: refresh token (from SAML assertion) — human login: yes (SAML)
- **Secrets** — 3 min — token: vaulted secret — human login: yes
- **Service Accounts** — 2 min — token: service-account username/password — human login: yes
- **NHI - Okta Protected Resource** — 3 min — token: `client_credentials` service token → id-JAG — human login: no
- **HI - A2A** — 4 min — token: second id-JAG (Finance Agent) — human login: yes
- **NHI - A2A** — 2 min — token: `client_credentials` → layered id-JAG — human login: no
- **STS Broker (GitHub)** — 5 min — token: Okta-brokered GitHub access token — human login: yes
