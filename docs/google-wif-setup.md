# Setup guide: Cross-App Access to Google Cloud via Workload Identity Federation

This guide configures Okta and Google Cloud so an AI agent can call **BigQuery** and **Google Drive** on behalf of a signed-in user, with no Google service account key. It is the setup for the **HI - Cross-App Access (Google Cloud via WIF)** flow (`xaa-gcp`) in this demo.

Google does not accept Okta ID-JAGs. The flow therefore ends the standard Cross-App Access chain at an Okta Custom Authorization Server whose audience is the Google workload identity provider. It then exchanges that Okta token at Google STS.

```
User login ──► T2 ID-JAG (Okta Org AS) ──► T3 Okta access token (Custom AS, aud = Google)
          ──► T4 Google federated token (Google STS) ──► T5 BigQuery
                                                     └─► T5–T7 Drive (service account impersonation)
```

Okta decides which agent may act for which user, and with which scopes. Google IAM decides what that federated identity may do in Google Cloud.

---

## 0. Before you start

You need:

- An Okta org with **Okta for AI Agents (O4AA)**. The JWT bearer grant on a Custom Authorization Server requires it.
- An AI agent registered in Okta that authenticates with a public/private key (`private_key_jwt`). This demo uses the agent from `AGENT_CLIENT_ID` / `AGENT_PRIVATE_KEY_FILE`.
- A Google Cloud project where you can manage IAM, and a BigQuery dataset.
- For the Drive "act as the user" mode only: super admin on a Google Workspace domain whose users match your Okta users' emails.

Pick your values first. Several of them must match exactly across Okta and Google.

| Value | Example used in this guide | Where it comes from |
|---|---|---|
| Okta org | `https://oktaforai.oktapreview.com` | Your Okta org URL |
| Custom AS issuer | `https://oktaforai.oktapreview.com/oauth2/aus167ep3e0LuYFsa1d8` | Created in step 1.1 |
| Agent client ID | `wlp12o2f7rsziAQkf1d8` | Okta → Directory → AI Agents |
| Google project ID | `o4aaproject` | First part of `project.dataset.table` |
| Google project number | `221328126369` | `gcloud projects describe o4aaproject --format='value(projectNumber)'` |
| Pool ID | `okta-agents-pool` | You choose it (step 2.2) |
| Provider ID | `okta-xaa-bq` | You choose it (step 2.3) |
| Table | `o4aaproject.inventory.items` | Your BigQuery table |

From these values, build the **provider name**. The rest of this guide calls it `PROVIDER`:

```
//iam.googleapis.com/projects/221328126369/locations/global/workloadIdentityPools/okta-agents-pool/providers/okta-xaa-bq
```

`PROVIDER` must be identical in three places:

1. The Okta Custom AS **Audience** (step 1.1).
2. The Google provider's **allowed audience** (step 2.3).
3. The `audience` the agent sends at T2 and T4. The demo builds this for you.

---

## 1. Okta configuration

### 1.1 Create a Custom Authorization Server dedicated to Google

Go to Security → API → Authorization Servers → **Add Authorization Server**.

- **Name:** for example, `Google Cloud (WIF)`.
- **Audience:** `PROVIDER`, exactly as built above.
- Save, then copy the **Issuer** (`https://<org>/oauth2/<id>`). You need it for Google in step 2.3.

Use a dedicated server rather than reusing one. Its tokens are addressed only to Google, so tokens for other resources can't be replayed at Google STS.

### 1.2 Add scopes

On the server's **Scopes** tab, add a coarse-grained scope that Google can gate on:

- `gcp.bigquery.read`

Google doesn't enforce Okta scopes by itself. A scope only matters on the Google side when the attribute condition in step 2.3 checks it.

### 1.3 Add an access policy and rule

On the **Access Policies** tab:

1. **Add Policy**, assigned to the AI agent's client (`wlp12o2f7rsziAQkf1d8`).
2. **Add Rule**:
   - **Grant type:** **JWT Bearer**. This is the grant that redeems the ID-JAG.
   - **Users / groups:** the users the agent may act for.
   - **Scopes:** `gcp.bigquery.read`.
   - **Access token lifetime:** short, for example 5–60 minutes. Deactivating the agent in Okta doesn't revoke Google tokens that were already issued, so short tokens limit the gap.

### 1.4 Claims

Keep the defaults:

- `sub` is the user. Google maps it to `google.subject`. It must be 127 characters or fewer, which an email is.
- `cid` is the agent's client ID. Google uses it to identify the agent.
- `scp` holds the granted scopes.

Add custom claims only if Google should map extra attributes, such as department.

### 1.5 Connect the agent to the Custom AS

Go to Directory → AI Agents → your agent → **Resource connections** → add a connection to the Custom AS from 1.1, allowing `gcp.bigquery.read`.

Without this connection, Okta refuses to issue the ID-JAG at T2.

---

## 2. Google Cloud configuration

Run these in Cloud Shell, or anywhere `gcloud` is authenticated as a project owner or IAM admin.

### 2.1 Enable the APIs

```sh
gcloud config set project o4aaproject
gcloud services enable iam.googleapis.com sts.googleapis.com \
  iamcredentials.googleapis.com bigquery.googleapis.com drive.googleapis.com
```

### 2.2 Create a workload identity pool

```sh
gcloud iam workload-identity-pools create okta-agents-pool \
  --location=global --display-name="Okta AI agents (XAA)"
```

Use a new pool rather than one built for another integration. Its existing attribute condition will likely reject these tokens. Deleted pool and provider IDs can't be reused for 30 days.

### 2.3 Add the OIDC provider that trusts the Okta Custom AS

```sh
gcloud iam workload-identity-pools providers create-oidc okta-xaa-bq \
  --location=global --workload-identity-pool=okta-agents-pool \
  --display-name="Okta Custom AS (Google)" \
  --issuer-uri="https://oktaforai.oktapreview.com/oauth2/aus167ep3e0LuYFsa1d8" \
  --allowed-audiences="//iam.googleapis.com/projects/221328126369/locations/global/workloadIdentityPools/okta-agents-pool/providers/okta-xaa-bq" \
  --attribute-mapping="google.subject=assertion.sub,attribute.client=assertion.cid,attribute.user=assertion.sub" \
  --attribute-condition="assertion.cid == 'wlp12o2f7rsziAQkf1d8' && 'gcp.bigquery.read' in assertion.scp"
```

- **`--issuer-uri`:** the Custom AS issuer, character for character, with no trailing slash. It is not the org URL.
- **`--allowed-audiences`:** `PROVIDER`.

**Attribute mapping:**

| Google attribute | Okta claim | Used in IAM as |
|---|---|---|
| `google.subject` | `sub` (user) | `principal://…/subject/<sub>` |
| `attribute.client` | `cid` (agent) | `principalSet://…/attribute.client/<agent client id>` |
| `attribute.user` | `sub` (user) | `principalSet://…/attribute.user/<sub>` |

**Attribute condition:** Google accepts a token only from your agent, and only with the BigQuery scope. This is the Google-side agent allow-list, so don't rely on Okta alone.

To allow several agents, each with its own scope:

```
(assertion.cid == '<agent A>' && 'mcp:read' in assertion.scp) ||
(assertion.cid == '<agent B>' && 'gcp.bigquery.read' in assertion.scp)
```

The pattern document maps the agent from `act.sub`. That mapping is a Preview capability in Google. If a token has no `act` claim, an expression using `assertion.act.sub` fails and STS rejects the token. Start with `cid`. Add `act` only after the T3 card shows an `act` claim, using `has(assertion.act) && …`.

### 2.4 Grant BigQuery access

Choose who to grant:

```sh
# Per agent: the agent can query for any user it acts for (simplest)
P="principalSet://iam.googleapis.com/projects/221328126369/locations/global/workloadIdentityPools/okta-agents-pool/attribute.client/wlp12o2f7rsziAQkf1d8"

# Per user: the agent sees only what this user may see
# P="principal://iam.googleapis.com/projects/221328126369/locations/global/workloadIdentityPools/okta-agents-pool/subject/<user sub>"
```

The user's `sub` is shown on the T3 card after a first run.

Grant the roles at the project level. Add `--condition=None`: if the project already has a conditional binding, gcloud otherwise prompts for a condition, and picking an existing one can silently disable the grant.

```sh
gcloud projects add-iam-policy-binding o4aaproject \
  --member="$P" --role=roles/bigquery.jobUser --condition=None

gcloud projects add-iam-policy-binding o4aaproject \
  --member="$P" --role=roles/bigquery.dataViewer --condition=None
```

**To limit data access to one table** instead of the whole project, replace the second command with:

```sh
bq add-iam-policy-binding --table=true \
  --member="$P" --role=roles/bigquery.dataViewer o4aaproject:inventory.items
```

Dataset-level `bq add-iam-policy-binding` fails with "This feature requires allowlisting". Use the table-level form, the project-level grant, or BigQuery → dataset → **Sharing → Permissions** in the Console.

`roles/bigquery.jobUser` must stay at the project level; it allows creating the query job.

Check the bindings:

```sh
gcloud projects get-iam-policy o4aaproject --flatten="bindings[].members" \
  --filter="bindings.members:workloadIdentityPools" \
  --format="table(bindings.role, bindings.members)"
```

IAM changes can take a minute or two to apply.

---

## 3. Google Drive (Workspace APIs): optional

Workspace APIs don't accept federated tokens. Instead, the federated identity impersonates a service account. There are two modes.

| Mode | Agent sees | Requires |
|---|---|---|
| `dwd` | The signed-in user's own Drive | A Workspace super admin to authorize domain-wide delegation. Okta user emails must be Workspace users. |
| `shared` | Only files shared with the service account | Nothing beyond Google Cloud IAM. Works without Workspace. |

### 3.1 Create the service account (both modes)

```sh
gcloud iam service-accounts create agent-workspace \
  --display-name="O4AA agent - Workspace (Drive read)"
SA=agent-workspace@o4aaproject.iam.gserviceaccount.com
```

Use one service account per scope tier, for example a separate one for write scopes.

### 3.2 Let the agent impersonate it

```sh
# dwd mode: the flow calls signJwt
gcloud iam service-accounts add-iam-policy-binding $SA \
  --member="$P" --role=roles/iam.serviceAccountTokenCreator --condition=None

# shared mode: the flow calls generateAccessToken
gcloud iam service-accounts add-iam-policy-binding $SA \
  --member="$P" --role=roles/iam.workloadIdentityUser --condition=None
```

Bind the agent's `principalSet` here, never the whole pool.

### 3.3a `dwd` mode: authorize domain-wide delegation

1. Get the service account's numeric client ID:
   ```sh
   gcloud iam service-accounts describe $SA --format='value(oauth2ClientId)'
   ```
2. As a Workspace super admin, open **admin.google.com** → Security → Access and data control → API controls → **Manage Domain Wide Delegation** → **Add new**.
   - **Client ID:** the number from step 1. Not the service account email.
   - **OAuth scopes:** `https://www.googleapis.com/auth/drive.readonly`, matching `GCP_WORKSPACE_SCOPES` exactly.
3. Authorize. It usually takes effect within minutes, sometimes up to 24 hours.

If the page is empty, nothing is authorized yet, and T6 fails with `unauthorized_client`. If you can't reach this page, you aren't a Workspace super admin. Use `shared` mode.

Domain-wide delegation lets the service account act as **any** user in the domain for the listed scopes. Keep the scopes read-only and minimal. This variant needs its own security review before production use.

### 3.3b `shared` mode: share files

In Drive, share a folder or files with `agent-workspace@o4aaproject.iam.gserviceaccount.com` as **Viewer**.

---

## 4. Demo app configuration (`.env`)

```
# Okta
GCP_XAA_AUTH_SERVER=https://oktaforai.oktapreview.com/oauth2/aus167ep3e0LuYFsa1d8
GCP_XAA_SCOPES=gcp.bigquery.read

# Google: these three build PROVIDER
GCP_PROJECT_NUMBER=221328126369
GCP_WIF_POOL_ID=okta-agents-pool
GCP_WIF_PROVIDER_ID=okta-xaa-bq

# BigQuery
GCP_PROJECT_ID=o4aaproject
GCP_BQ_QUERY=SELECT * FROM `o4aaproject.inventory.items` LIMIT 10
# GCP_BQ_LOCATION=US          # set if the dataset is not in the US multi-region

# Drive (optional)
GCP_WORKSPACE_SA_EMAIL=agent-workspace@o4aaproject.iam.gserviceaccount.com
# GCP_WORKSPACE_SUBJECT=      # dwd: user to impersonate; default = the id_token email
```

The agent itself is configured through the existing `AGENT_CLIENT_ID`, `AGENT_PRIVATE_KEY_FILE` and `AGENT_KID`.

The T2 audience defaults to `PROVIDER`. Set `GCP_IDJAG_AUDIENCE` only if your Custom AS Audience differs. All options are listed in `.env.example`.

Restart the server after editing `.env`. Then open the flow and click **Query BigQuery**, **List my Drive files (DWD)** or **List Drive files (Shared)**. The Drive mode is chosen by the button you click, not in `.env`; a panel above the buttons explains the difference.

---

## 5. Verify: what each step should show

| Step | Call | Success looks like |
|---|---|---|
| T1 | Okta login | `id_token` for the user |
| T2 | Org AS token exchange → ID-JAG | ID-JAG with `aud` = `PROVIDER`; about 5 minutes, single use |
| T3 | Custom AS jwt-bearer | Okta access token with `iss` = Custom AS, `aud` = `PROVIDER`, `sub` = user, `cid` = agent. The card reports "Claim check passed" and lists what Google will map. |
| T4 | Google STS | `access_token` with `expires_in` of at most 3600 |
| T5 | BigQuery `jobs.query` | Rows from your table. `SESSION_USER()` returns the federated identity. |
| T5–T7 | Drive (`dwd`) | `signJwt` → `oauth2.googleapis.com/token` → `files.list` with the user's files |
| T5–T6 | Drive (`shared`) | `generateAccessToken` → `files.list` with the shared files |

Audit trail: the Okta System Log records the ID-JAG and access token issuance (user and agent), linked from each card. Cloud Audit Logs record the federated identity on every Google API call.

---

## 6. Troubleshooting

| Step | Error | Cause | Fix |
|---|---|---|---|
| T2 | `invalid_target`: "must include a valid audience of the authorization server" | The T2 `audience` doesn't equal the Custom AS's configured Audience | Make the Custom AS Audience `PROVIDER`. The demo sends `PROVIDER` by default. |
| T2 | `invalid_scope` / not authorized | No resource connection from the agent to the Custom AS, or the scope isn't allowed | Step 1.5 |
| T3 | `access_denied` / no matching policy | No access-policy rule for this agent with the JWT Bearer grant | Step 1.3 |
| T4 | "The given credential is rejected by the attribute condition." | The condition is false for this token: wrong `cid`, missing scope, or a reference to an absent `act` | Compare the condition with the claims on the T3 card. Update it with `gcloud iam workload-identity-pools providers update-oidc … --attribute-condition=…` |
| T4 | `invalid_grant` on issuer or audience | `--issuer-uri` ≠ the token's `iss`, or the allowed audience ≠ the token's `aud` | Step 2.3; check for trailing slashes |
| T5 | 403 "does not have bigquery.jobs.create" | No `roles/bigquery.jobUser` for the federated identity | Step 2.4 |
| T5 | 403 access denied on the table | No `roles/bigquery.dataViewer` | Step 2.4 |
| (setup) | `bq add-iam-policy-binding`: "requires allowlisting" | Dataset-level IAM through `bq` | Use the project-level, table-level or Console grant (step 2.4) |
| (setup) | gcloud prompts "specifying a condition is required" | The project already has a conditional binding | Choose **None**, or pass `--condition=None` |
| T5 (Drive) | 403 on `signJwt` / `generateAccessToken` | Missing impersonation role on the service account, or `$P` uses the wrong attribute name | Step 3.2; check `attribute.client` against your mapping |
| T6 (Drive) | `unauthorized_client` | Domain-wide delegation isn't authorized for this client ID and scope, or hasn't applied yet | Step 3.3a, or switch to `shared` |
| T6 (Drive) | `invalid_grant` / invalid email | The impersonated email isn't a user in that Workspace | Set `GCP_WORKSPACE_SUBJECT` to a real Workspace user |

Useful inspection commands:

```sh
gcloud iam workload-identity-pools providers describe okta-xaa-bq \
  --location=global --workload-identity-pool=okta-agents-pool \
  --format="yaml(attributeCondition,attributeMapping,oidc)"
```

---

## 7. Security notes

- **No long-lived Google credentials.** The agent never holds a service account key. Every token in the chain is short-lived.
- **Audience binding.** The dedicated Custom AS means only tokens minted for Google are accepted by Google STS.
- **Gate on both sides.** Okta controls the agent, user and scopes. Google's attribute condition repeats the agent allow-list.
- **IAM grants add up.** Per-user and per-agent grants combine as OR. To require "this agent" **and** "this user's entitlement", gate the agent in the attribute condition and grant data access only to the user identity.
- **Revocation gap.** Deactivating the agent in Okta stops new tokens, but issued Google tokens stay valid for up to 1 hour. Keep the Okta access token lifetime short.
- **Domain-wide delegation** grants domain-wide impersonation for its scopes. Use minimal scopes and one service account per tier, bind impersonation only to the agent's `principalSet`, and review it separately.
