#!/usr/bin/env python3
"""
HI - Cross-App Access (Atlassian) — the whole flow end to end, standalone.

  P0  (one-time, --register) Dynamic Client Registration at Atlassian → client_id/secret
  T0  browser → Okta /authorize (Authorization Code + PKCE)
  T1  code → id_token at Okta /token (private_key_jwt)
  T2  id_token → id-JAG at the Okta ORG auth server (audience = Atlassian issuer)
  T3  id-JAG → Atlassian access token (jwt-bearer + DCR client credentials)
  T4  Atlassian Rovo MCP initialize
  T5  accessible Atlassian sites (unless ATLASSIAN_XAA_CLOUD_ID is set)
  T6  MCP tools/call — searchJiraIssuesUsingJql (read) or createJiraIssue (create)

Reads the same .env as the Node app (OKTA_*, AGENT_*, ATLASSIAN_XAA_*) and the same DCR
credentials file (keys/atlassian-dcr.json), so it runs exactly what the UI runs.

Setup:
  pip install "pyjwt[crypto]"

Usage (from the project root):
  python3 scripts/xaa_atlassian.py                    # read Jira tickets
  python3 scripts/xaa_atlassian.py --action create    # create a Jira ticket
  python3 scripts/xaa_atlassian.py --register         # one-time DCR (refuses if registered)
  python3 scripts/xaa_atlassian.py --register --force # new DCR → NEW client_id (update Okta)
  python3 scripts/xaa_atlassian.py --show-tokens      # print raw tokens (local debugging only)

Login: the script listens on OKTA_REDIRECT_URI (e.g. http://localhost:8080/api/callback) to
catch the code. If that port is busy (the Node app is running), it asks you to paste the
final redirect URL from the browser instead.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

try:
    import jwt  # PyJWT
except ImportError:
    sys.exit('Missing dependency: pip install "pyjwt[crypto]"')

ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS_FILE = ROOT / "keys" / "atlassian-dcr.json"
RECORD_FILE = ROOT / "registrations" / "atlassian-dcr.json"

GRANT_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange"
GRANT_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"
TOKEN_TYPE_ID_TOKEN = "urn:ietf:params:oauth:token-type:id_token"
TOKEN_TYPE_ID_JAG = "urn:ietf:params:oauth:token-type:id-jag"
TOKEN_TYPE_ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token"
CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
MCP_PROTOCOL_VERSION = "2025-06-18"

DEFAULT_SCOPES = (
    "read:account read:me read:jira-work write:jira-work read:all:twg write:all:twg "
    "read:page:confluence read:space:confluence search:confluence"
)

SHOW_TOKENS = False


# ───────────────────────────── config ─────────────────────────────


def load_env(path: Path) -> None:
    """Minimal .env loader (same precedence as the Node app: the file wins)."""
    if not path.exists():
        sys.exit(f"No .env at {path}")
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if value[:1] in ("'", '"') and value[-1:] == value[:1]:
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        os.environ[key] = value


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or default


def token_endpoint(auth_server: str) -> str:
    base = auth_server.rstrip("/")
    return f"{base}/v1/token" if "/oauth2" in base else f"{base}/oauth2/v1/token"


def build_config(args) -> dict:
    issuer = env("OKTA_ISSUER")
    org = (env("OKTA_ORG_URL") or issuer or "").split("/oauth2/")[0].rstrip("/")
    atl_issuer = (env("ATLASSIAN_XAA_ISSUER") or "").rstrip("/")
    cfg = {
        # T0/T1 — regular agent login
        "okta_issuer": issuer,
        "login_client_id": env("OKTA_CLIENT_ID"),
        "redirect_uri": env("OKTA_REDIRECT_URI"),
        "login_scopes": env("OKTA_SCOPES", "openid profile email"),
        "login_auth": env("OKTA_TOKEN_AUTH_METHOD", "private_key_jwt"),
        "login_secret": env("OKTA_CLIENT_SECRET"),
        "login_key_file": env("OKTA_PRIVATE_KEY_FILE") or env("AGENT_PRIVATE_KEY_FILE"),
        "login_kid": env("OKTA_KID") or env("AGENT_KID"),
        # T2 — id-JAG at the ORG auth server
        "org_token_url": f"{org}/oauth2/v1/token" if org else None,
        "agent_client_id": env("AGENT_CLIENT_ID"),
        "agent_key_file": env("AGENT_PRIVATE_KEY_FILE"),
        "agent_kid": env("AGENT_KID"),
        # Atlassian
        "atl_issuer": atl_issuer,
        "atl_registration_url": env("ATLASSIAN_XAA_REGISTRATION_URL") or (f"{atl_issuer}/dcr/register" if atl_issuer else None),
        "atl_audience": env("ATLASSIAN_XAA_AUDIENCE") or atl_issuer,
        "atl_resource": env("ATLASSIAN_XAA_RESOURCE"),
        "atl_scopes": env("ATLASSIAN_XAA_SCOPES", DEFAULT_SCOPES),
        "atl_token_url": env("ATLASSIAN_XAA_TOKEN_URL", "https://auth.atlassian.com/oauth/token"),
        "atl_client_name": env("ATLASSIAN_XAA_CLIENT_NAME", "O4AA-Agent-XAA"),
        "atl_redirect_uri": env("ATLASSIAN_XAA_REDIRECT_URI")
        or f"{(env('APP_BASE_URL') or 'http://localhost:8080').rstrip('/')}/api/xaa-atlassian/callback",
        "mcp_url": env("ATLASSIAN_XAA_MCP_URL", "https://mcp.atlassian.com/v1/mcp/authv2"),
        "cloud_id": args.cloud_id or env("ATLASSIAN_XAA_CLOUD_ID"),
        "project_key": args.project or env("ATLASSIAN_XAA_PROJECT_KEY") or env("ATLASSIAN_STS_PROJECT_KEY"),
        "issue_type": env("ATLASSIAN_XAA_ISSUE_TYPE") or env("ATLASSIAN_STS_ISSUE_TYPE") or "Task",
        "issue_summary": env("ATLASSIAN_XAA_ISSUE_SUMMARY", "Automated ticket via Okta Cross-App Access"),
        "issue_description": env(
            "ATLASSIAN_XAA_ISSUE_DESCRIPTION",
            "Created by the AI agent with an Atlassian token redeemed from an Okta id-JAG (Cross-App Access).",
        ),
        "max_results": int(env("ATLASSIAN_XAA_MAX_RESULTS", "10")),
    }
    return cfg


def require(cfg: dict, *keys: str) -> None:
    names = {
        "okta_issuer": "OKTA_ISSUER", "login_client_id": "OKTA_CLIENT_ID", "redirect_uri": "OKTA_REDIRECT_URI",
        "agent_client_id": "AGENT_CLIENT_ID", "agent_key_file": "AGENT_PRIVATE_KEY_FILE", "agent_kid": "AGENT_KID",
        "atl_issuer": "ATLASSIAN_XAA_ISSUER", "org_token_url": "OKTA_ORG_URL (or OKTA_ISSUER)",
        "atl_registration_url": "ATLASSIAN_XAA_ISSUER",
    }
    missing = [names.get(k, k) for k in keys if not cfg.get(k)]
    if missing:
        sys.exit("Missing configuration: " + ", ".join(missing))


# ───────────────────────────── output ─────────────────────────────


def mask(v) -> str:
    v = str(v or "")
    if SHOW_TOKENS:
        return v
    return f"{v[:8]}…{v[-4:]}" if len(v) > 16 else "••••"


def decode_jwt(token: str) -> dict | None:
    """Decode header + payload for display only — no signature verification."""

    def part(seg: str) -> dict:
        return json.loads(base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4)))

    try:
        header, payload = token.split(".")[:2]
        return {"header": part(header), "payload": part(payload)}
    except Exception:
        return None


def banner(step_id: str, title: str, route: str) -> None:
    print(f"\n\033[1m━━ {step_id} · {title}\033[0m   ({route})")


def show(label: str, value) -> None:
    text = value if isinstance(value, str) else json.dumps(value, indent=2, default=str)
    print(f"  {label}:")
    for line in text.splitlines():
        print(f"    {line}")


def show_jwt(label: str, token: str) -> None:
    d = decode_jwt(token)
    if d:
        show(f"{label} (decoded, not verified)", d["payload"])
    if SHOW_TOKENS:
        show(f"{label} (raw)", token)


SECRET_PARAMS = {"client_assertion", "subject_token", "assertion", "client_secret", "code", "code_verifier"}


def show_form(params: dict) -> None:
    show("request", {k: (mask(v) if k in SECRET_PARAMS else v) for k, v in params.items()})


def fail(step_id: str, msg: str) -> None:
    print(f"\n\033[31m✗ {step_id} failed: {msg}\033[0m")
    sys.exit(1)


# ───────────────────────────── HTTP ─────────────────────────────

_ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)


def http(method: str, url: str, *, form: dict | None = None, json_body=None, headers: dict | None = None, timeout=60):
    """Returns (status, headers, parsed_body). Never raises on HTTP errors."""
    h = {"Accept": "application/json", **(headers or {})}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    elif json_body is not None:
        data = json.dumps(json_body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, context=_ctx, timeout=timeout) as res:
            status, rh, raw = res.status, dict(res.headers), res.read().decode()
    except urllib.error.HTTPError as e:
        status, rh, raw = e.code, dict(e.headers), e.read().decode()
    except urllib.error.URLError as e:
        return 0, {}, {"error": "network_error", "error_description": str(e.reason)}
    try:
        body = json.loads(raw) if raw else ""
    except json.JSONDecodeError:
        body = raw
    return status, {k.lower(): v for k, v in rh.items()}, body


# ───────────────────────────── signing ─────────────────────────────


def client_assertion(client_id: str, audience: str, key_file: str, kid: str) -> str:
    """private_key_jwt (RFC 7523 §2.2): iss = sub = client_id, aud = the token endpoint."""
    path = Path(key_file)
    path = path if path.is_absolute() else ROOT / path
    if not path.exists():
        sys.exit(f"Private key not found at {path}")
    now = int(time.time())
    return jwt.encode(
        {"iss": client_id, "sub": client_id, "aud": audience, "iat": now, "exp": now + 300, "jti": secrets.token_urlsafe(16)},
        path.read_text(),
        algorithm="RS256",
        headers={"kid": kid, "typ": "JWT"},
    )


# ───────────────────────────── P0 · DCR ─────────────────────────────


def load_credentials() -> dict | None:
    cid, secret = env("ATLASSIAN_XAA_CLIENT_ID"), env("ATLASSIAN_XAA_CLIENT_SECRET")
    if cid:
        return {"client_id": cid, "client_secret": secret, "source": "env"}
    if CREDENTIALS_FILE.exists():
        data = json.loads(CREDENTIALS_FILE.read_text())
        if data.get("client_id"):
            return {"client_id": data["client_id"], "client_secret": data.get("client_secret"), "source": str(CREDENTIALS_FILE.relative_to(ROOT))}
    return None


def register(cfg: dict, force: bool) -> None:
    require(cfg, "atl_registration_url")
    existing = load_credentials()
    if existing and not force:
        sys.exit(
            f"Already registered: client_id {existing['client_id']} (from {existing['source']}).\n"
            "Re-run with --register --force for a NEW registration (then update Okta with the new client_id)."
        )
    payload = {
        "client_name": cfg["atl_client_name"],
        "redirect_uris": [cfg["atl_redirect_uri"]],
        "grant_types": ["authorization_code", "refresh_token", GRANT_JWT_BEARER],
        "response_types": ["code"],
    }
    banner("P0", "Dynamic Client Registration (one-time)", "Agent → Atlassian Auth Server")
    print(f"  POST {cfg['atl_registration_url']}")
    show("request", payload)
    status, headers, body = http("POST", cfg["atl_registration_url"], json_body=payload)
    redacted = dict(body) if isinstance(body, dict) else body
    if isinstance(redacted, dict):
        for f in ("client_secret", "registration_access_token"):
            if redacted.get(f):
                redacted[f] = f"{str(redacted[f])[:8]}…{str(redacted[f])[-4:]} [redacted]"
    show(f"response {status}", redacted)
    if status not in (200, 201) or not isinstance(body, dict) or not body.get("client_id"):
        fail("P0", f"Atlassian DCR returned HTTP {status}")

    registered_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    CREDENTIALS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CREDENTIALS_FILE.write_text(json.dumps({
        "issuer": cfg["atl_issuer"],
        "client_id": body["client_id"],
        "client_secret": body.get("client_secret"),
        **({"registration_access_token": body["registration_access_token"]} if body.get("registration_access_token") else {}),
        **({"registration_client_uri": body["registration_client_uri"]} if body.get("registration_client_uri") else {}),
        "registered_at": registered_at,
    }, indent=2) + "\n")
    os.chmod(CREDENTIALS_FILE, 0o600)

    # Same record shape the Node app writes — the UI's Prerequisite panel shows it.
    RECORD_FILE.parent.mkdir(parents=True, exist_ok=True)
    keep = {k: headers[k] for k in ("content-type", "cache-control", "atl-traceid", "date") if k in headers}
    RECORD_FILE.write_text(json.dumps({
        "registeredAt": registered_at,
        "issuer": cfg["atl_issuer"],
        "clientId": body["client_id"],
        "step": {
            "id": "P0", "title": "Dynamic Client Registration (one-time)", "badge": "DCR",
            "from": "Agent", "to": "Atlassian Auth Server", "ok": True,
            "note": "One-time prerequisite. The client_id and client_secret returned here are what T3 sends to "
                    "auth.atlassian.com/oauth/token together with the id-JAG. Configure this client_id on the "
                    "Atlassian resource in Okta’s Cross-App Access settings.",
            "expandHeaders": False,
            "request": {"method": "POST", "url": cfg["atl_registration_url"],
                        "headers": {"Content-Type": "application/json", "Accept": "application/json"},
                        "body": json.dumps(payload, indent=2)},
            "response": {"status": status, "headers": keep, "body": redacted},
            "token": None,
            "code": f"curl -X POST '{cfg['atl_registration_url']}' \\\n  -H 'Content-Type: application/json' \\\n"
                    f"  -H 'Accept: application/json' \\\n  -d '{json.dumps(payload)}'",
        },
    }, indent=2) + "\n")

    print(f"\n\033[32m✓ Registered client_id: {body['client_id']}\033[0m  (client_secret returned: {bool(body.get('client_secret'))})")
    print(f"  credentials → {CREDENTIALS_FILE.relative_to(ROOT)}  (gitignored)")
    print(f"  record      → {RECORD_FILE.relative_to(ROOT)}  (commit this)")
    print("  Next: set this client_id on the Atlassian resource in Okta's Cross-App Access settings.")


# ───────────────────────────── T0 / T1 · login ─────────────────────────────


def discover(issuer: str) -> dict:
    status, _, body = http("GET", f"{issuer.rstrip('/')}/.well-known/openid-configuration")
    if status != 200 or not isinstance(body, dict):
        sys.exit(f"OIDC discovery failed for {issuer}: HTTP {status}")
    return body


def wait_for_redirect(redirect_uri: str, authorize_url: str, open_browser: bool) -> str:
    """Catch the redirect on redirect_uri if it's local and the port is free; else ask for a paste."""
    u = urllib.parse.urlparse(redirect_uri)
    captured: dict = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if urllib.parse.urlparse(self.path).path != u.path:
                self.send_response(404)
                self.end_headers()
                return
            captured["url"] = f"{u.scheme}://{u.netloc}{self.path}"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h3>Signed in. You can close this tab and return to the terminal.</h3>")

        def log_message(self, *a):
            pass

    server = None
    if u.hostname in ("localhost", "127.0.0.1"):
        try:
            server = http.server.HTTPServer((u.hostname, u.port or 80), Handler)
        except OSError:
            print(f"  (port {u.port} is busy — probably the Node app; falling back to paste)")

    print(f"\n  Open this URL and sign in:\n    {authorize_url}\n")
    if open_browser:
        webbrowser.open(authorize_url)

    if server:
        print(f"  Waiting for the redirect on {redirect_uri} …")
        # Serve requests one at a time (favicon etc. are 404'd) until the callback arrives.
        server.timeout = 1
        deadline = time.time() + 300
        while "url" not in captured and time.time() < deadline:
            server.handle_request()
        server.server_close()
        if "url" in captured:
            return captured["url"]
        sys.exit("Timed out waiting for the login redirect.")
    return input("  Paste the complete redirect URL from the browser address bar: ").strip()


def login(cfg: dict, open_browser: bool, prompt_login: bool) -> str:
    require(cfg, "okta_issuer", "login_client_id", "redirect_uri")
    meta = discover(cfg["okta_issuer"])
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state, nonce = secrets.token_urlsafe(16), secrets.token_urlsafe(16)
    params = {
        "client_id": cfg["login_client_id"],
        "response_type": "code",
        "scope": cfg["login_scopes"],
        "redirect_uri": cfg["redirect_uri"],
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if prompt_login:
        params["prompt"] = "login"

    banner("T0", "Authorization Request", "User (browser) → Okta")
    authorize_url = f"{meta['authorization_endpoint']}?{urllib.parse.urlencode(params)}"
    redirect = wait_for_redirect(cfg["redirect_uri"], authorize_url, open_browser)
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(redirect).query))
    if q.get("error"):
        fail("T0", f"{q['error']}: {q.get('error_description', '')}")
    if q.get("state") != state:
        fail("T0", "state mismatch — paste the redirect from THIS login attempt")
    print(f"  ✓ authorization code received ({mask(q.get('code'))})")

    banner("T1", "User Login (code → id_token)", "Agent → Okta")
    token_url = meta["token_endpoint"]
    form = {"grant_type": "authorization_code", "code": q["code"], "redirect_uri": cfg["redirect_uri"], "code_verifier": verifier}
    headers = {}
    method = cfg["login_auth"]
    if method == "private_key_jwt":
        require(cfg, "login_key_file", "login_kid")
        form |= {
            "client_id": cfg["login_client_id"],
            "client_assertion_type": CLIENT_ASSERTION_TYPE,
            "client_assertion": client_assertion(cfg["login_client_id"], token_url, cfg["login_key_file"], cfg["login_kid"]),
        }
    elif method == "client_secret_basic":
        basic = base64.b64encode(f"{cfg['login_client_id']}:{cfg['login_secret']}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    else:  # client_secret_post
        form |= {"client_id": cfg["login_client_id"], "client_secret": cfg["login_secret"]}
    print(f"  POST {token_url}")
    show_form(form)
    status, _, body = http("POST", token_url, form=form, headers=headers)
    if status != 200 or not isinstance(body, dict) or not body.get("id_token"):
        show(f"response {status}", body)
        fail("T1", "no id_token returned")
    id_token = body["id_token"]
    claims = decode_jwt(id_token)["payload"]
    if claims.get("nonce") != nonce:
        fail("T1", "id_token nonce mismatch")
    print(f"  ✓ id_token for {claims.get('email') or claims.get('sub')} (expires {datetime.fromtimestamp(claims['exp']).isoformat()})")
    show_jwt("id_token", id_token)
    return id_token


# ───────────────────────────── T2 / T3 · id-JAG → Atlassian token ─────────────────────────────


def request_id_jag(cfg: dict, id_token: str) -> tuple[str, dict]:
    require(cfg, "org_token_url", "agent_client_id", "agent_key_file", "agent_kid", "atl_issuer")
    banner("T2", "Token Exchange → ID-JAG (for Atlassian)", "Agent → Okta Org Server")
    form = {
        "grant_type": GRANT_TOKEN_EXCHANGE,
        "subject_token": id_token,
        "subject_token_type": TOKEN_TYPE_ID_TOKEN,
        "requested_token_type": TOKEN_TYPE_ID_JAG,
        "audience": cfg["atl_audience"],
        "scope": cfg["atl_scopes"],
        "client_assertion_type": CLIENT_ASSERTION_TYPE,
        "client_assertion": client_assertion(cfg["agent_client_id"], cfg["org_token_url"], cfg["agent_key_file"], cfg["agent_kid"]),
    }
    if cfg["atl_resource"]:
        form["resource"] = cfg["atl_resource"]
    print(f"  POST {cfg['org_token_url']}")
    show_form(form)
    status, _, body = http("POST", cfg["org_token_url"], form=form)
    if status != 200 or not isinstance(body, dict) or not body.get("access_token"):
        show(f"response {status}", body)
        fail("T2", "Okta did not return an id-JAG")
    id_jag = body["access_token"]
    claims = (decode_jwt(id_jag) or {}).get("payload", {})
    print(f"  ✓ id-JAG issued (expires in {body.get('expires_in')}s)")
    show_jwt("id-JAG", id_jag)
    return id_jag, claims


def check_id_jag(cfg: dict, claims: dict, creds: dict) -> None:
    """Warn (don't fail) on claims Atlassian will check — Atlassian is the authority."""
    warnings = []
    if claims.get("aud") != cfg["atl_issuer"]:
        warnings.append(f"aud is {claims.get('aud')!r}, expected the Atlassian issuer {cfg['atl_issuer']!r}")
    known = {creds["client_id"], cfg["agent_client_id"]}
    if claims.get("client_id") and claims["client_id"] not in known:
        warnings.append(f"client_id is {claims['client_id']!r} — neither the DCR client_id nor the agent's client_id")
    for w in warnings:
        print(f"  \033[33m⚠ {w}\033[0m")
    if not warnings:
        print(f"  ✓ claim check: aud = Atlassian issuer, client_id = {claims.get('client_id')}, aud_tenant = {claims.get('aud_tenant')}")


def redeem_at_atlassian(cfg: dict, id_jag: str, creds: dict) -> str:
    banner("T3", "Access Token Request (Atlassian)", "Agent → Atlassian Auth Server")
    form = {
        "grant_type": GRANT_JWT_BEARER,
        "assertion": id_jag,
        "client_id": creds["client_id"],
        "requested_token_type": TOKEN_TYPE_ACCESS_TOKEN,
    }
    if creds.get("client_secret"):
        form["client_secret"] = creds["client_secret"]
    print(f"  POST {cfg['atl_token_url']}   (DCR credentials from {creds['source']})")
    show_form(form)
    status, headers, body = http("POST", cfg["atl_token_url"], form=form)
    trace = headers.get("atl-traceid")
    if trace:
        print(f"  atl-traceid: {trace}")
    if status != 200 or not isinstance(body, dict) or not body.get("access_token"):
        show(f"response {status}", body)
        fail("T3", "Atlassian rejected the id-JAG redemption" + (f" (give atl-traceid {trace} to Atlassian support)" if trace else ""))
    print(f"  ✓ Atlassian access token (type {body.get('token_type')}, expires in {body.get('expires_in')}s)")
    print(f"    scope: {body.get('scope')}")
    if SHOW_TOKENS:
        show("access_token (raw)", body["access_token"])
    return body["access_token"]


# ───────────────────────────── T4+ · Atlassian Rovo MCP ─────────────────────────────


def parse_rpc(text, rpc_id):
    """Streamable HTTP response: plain JSON or an SSE stream of data: frames."""
    if isinstance(text, (dict, list)):
        return text
    msgs = []
    for block in str(text).replace("\r\n", "\n").split("\n\n"):
        data = "\n".join(l[5:].lstrip() for l in block.split("\n") if l.startswith("data:"))
        if data:
            try:
                msgs.append(json.loads(data))
            except json.JSONDecodeError:
                pass
    return next((m for m in msgs if m.get("id") == rpc_id), msgs[0] if msgs else text)


class Mcp:
    def __init__(self, url: str, token: str, first_step: int):
        self.url, self.token, self.n, self.rpc_id, self.session_id = url, token, first_step, 0, None

    def _post(self, payload: dict):
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        status, rh, body = http("POST", self.url, json_body=payload, headers=headers)
        if rh.get("mcp-session-id"):
            self.session_id = rh["mcp-session-id"]
        return status, parse_rpc(body, payload.get("id"))

    def step(self, title: str) -> None:
        banner(f"T{self.n}", title, "Agent → Atlassian MCP")
        self.n += 1

    def initialize(self) -> None:
        self.step("Atlassian MCP · initialize")
        self.rpc_id += 1
        payload = {"jsonrpc": "2.0", "id": self.rpc_id, "method": "initialize",
                   "params": {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {},
                              "clientInfo": {"name": "o4aa-agent-python", "version": "1.0.0"}}}
        print(f"  POST {self.url}")
        status, body = self._post(payload)
        if not (200 <= status < 300 and isinstance(body, dict) and body.get("result")):
            show(f"response {status}", body)
            fail(f"T{self.n - 1}", "could not open an MCP session (check ATLASSIAN_XAA_MCP_URL and the token)")
        info = body["result"].get("serverInfo", {})
        print(f"  ✓ session {self.session_id or '(none)'} · server {info.get('name')} {info.get('version', '')}")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def tool_schema(self, name: str) -> dict | None:
        self.step(f"Atlassian MCP · tools/list ({name} schema)")
        self.rpc_id += 1
        status, body = self._post({"jsonrpc": "2.0", "id": self.rpc_id, "method": "tools/list", "params": {}})
        tools = (body.get("result") or {}).get("tools", []) if isinstance(body, dict) else []
        tool = next((t for t in tools if t.get("name") == name), None)
        print(f"  {len(tools)} tools available; {name}: {'found' if tool else 'NOT found'}")
        return (tool or {}).get("inputSchema")

    def call(self, name: str, arguments: dict):
        self.step(f"MCP Tool Call · {name}")
        self.rpc_id += 1
        show("arguments", arguments)
        status, body = self._post({"jsonrpc": "2.0", "id": self.rpc_id, "method": "tools/call",
                                   "params": {"name": name, "arguments": arguments}})
        result = body.get("result") if isinstance(body, dict) else None
        if not (200 <= status < 300 and result and not result.get("isError")):
            show(f"response {status}", body)
            fail(f"T{self.n - 1}", f"{name} failed")
        text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        try:
            return result.get("structuredContent") or json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return text


def resolve_site(cfg: dict, mcp: Mcp, token: str, aud_tenant: str | None) -> str:
    """The Jira site the app is installed on: config, else the token's accessible sites, else aud_tenant."""
    if cfg["cloud_id"]:
        c = cfg["cloud_id"]
        if "-" in c and len(c) == 36:
            return c
        host = c.replace("https://", "").replace("http://", "").split("/")[0]
        return f"https://{host if '.' in host else host + '.atlassian.net'}"
    mcp.step("Accessible Atlassian Sites")
    url = "https://api.atlassian.com/oauth/token/accessible-resources"
    print(f"  GET {url}")
    status, _, body = http("GET", url, headers={"Authorization": f"Bearer {token}"})
    sites = body if isinstance(body, list) else []
    for s in sites:
        print(f"    • {s.get('name')}  {s.get('url')}  id={s.get('id')}")
    site = next((s for s in sites if any("jira" in sc for sc in s.get("scopes", []))), sites[0] if sites else None)
    if site:
        print(f"  ✓ using {site.get('url')} ({site.get('id')})")
        return site.get("id") or site.get("url")
    if aud_tenant:
        print(f"  \033[33m⚠ no accessible sites (HTTP {status}) — falling back to id-JAG aud_tenant {aud_tenant}\033[0m")
        return aud_tenant
    fail("site", "the token cannot reach any Atlassian site — set ATLASSIAN_XAA_CLOUD_ID")
    return ""


def find_issues(data, depth=0):
    """First array of objects that look like Jira issues (have a KEY-123 key), any envelope."""
    import re
    if depth > 6 or data is None:
        return []
    if isinstance(data, str):
        try:
            return find_issues(json.loads(data), depth + 1)
        except json.JSONDecodeError:
            return []
    if isinstance(data, list):
        if any(isinstance(x, dict) and re.match(r"^[A-Z][A-Z0-9_]+-\d+$", str(x.get("key") or "")) for x in data):
            return data
        for x in data:
            if found := find_issues(x, depth + 1):
                return found
    if isinstance(data, dict):
        for v in data.values():
            if found := find_issues(v, depth + 1):
                return found
    return []


def label(v):
    return (v.get("displayName") or v.get("name") or v.get("value") or "") if isinstance(v, dict) else (v or "")


def read_issues(cfg: dict, mcp: Mcp, cloud_id: str) -> None:
    jql = f'project = "{cfg["project_key"]}" ORDER BY created DESC' if cfg["project_key"] else "created >= -3650d ORDER BY created DESC"
    data = mcp.call("searchJiraIssuesUsingJql", {"cloudId": cloud_id, "jql": jql,
                                                 "fields": ["summary", "status", "assignee"], "maxResults": cfg["max_results"]})
    issues = find_issues(data)
    print(f"\n\033[32m✓ {len(issues)} Jira ticket(s) in {cfg['project_key'] or 'all projects'}\033[0m")
    for i in issues:
        f = i.get("fields", i)
        assignee = label(f.get("assignee"))
        print(f"  • {i.get('key')} — {label(f.get('summary'))} [{label(f.get('status')) or 'unknown'}]{' · ' + assignee if assignee else ''}")
    if not issues:
        show("raw tool output", data if isinstance(data, str) else json.dumps(data, indent=2)[:2000])


def create_issue(cfg: dict, mcp: Mcp, cloud_id: str) -> None:
    import re
    project = cfg["project_key"]
    if not project:
        data = mcp.call("searchJiraIssuesUsingJql", {"cloudId": cloud_id, "jql": "created >= -3650d ORDER BY created DESC",
                                                     "fields": ["project"], "maxResults": 1})
        first = (find_issues(data) or [{}])[0]
        project = (first.get("fields", {}).get("project") or {}).get("key") or (first.get("key") or "").split("-")[0]
        if not project:
            fail("create", "no Jira project found — set ATLASSIAN_XAA_PROJECT_KEY or pass --project")
    schema = mcp.tool_schema("createJiraIssue") or {}
    props = schema.get("properties", {})

    def pick(*names):
        return next((n for n in names if n in props), None)

    def shape(k, obj):
        return obj if props.get(k, {}).get("type") == "object" else next(iter(obj.values()))

    if props:
        args = {}
        for keys, val in (
            (("cloudId", "cloudID", "siteId", "site"), cloud_id),
            (("summary", "title"), cfg["issue_summary"]),
            (("description", "body"), cfg["issue_description"]),
        ):
            if k := pick(*keys):
                args[k] = val
        if k := pick("projectKey", "project", "projectIdOrKey", "projectId"):
            args[k] = shape(k, {"key": project})
        if k := pick("issueType", "issueTypeName", "issuetype", "type"):
            args[k] = shape(k, {"name": cfg["issue_type"]})
    else:
        args = {"cloudId": cloud_id, "projectKey": project, "issueType": cfg["issue_type"],
                "summary": cfg["issue_summary"], "description": cfg["issue_description"]}
    data = mcp.call("createJiraIssue", args)
    text = json.dumps(data) if not isinstance(data, str) else data
    key = next(iter(re.findall(r"\b[A-Z][A-Z0-9_]+-\d+\b", text)), None)
    link = next(iter(re.findall(r"https?://[^\s\"')]+/browse/[^\s\"')]+", text)), None)
    print(f"\n\033[32m✓ Jira ticket created{': ' + key if key else ''}\033[0m")
    print(f"  project {project} · type {cfg['issue_type']} · summary {cfg['issue_summary']!r}")
    if link:
        print(f"  {link}")


# ───────────────────────────── main ─────────────────────────────


def main() -> None:
    global SHOW_TOKENS
    p = argparse.ArgumentParser(description="HI - Cross-App Access (Atlassian), end to end.")
    p.add_argument("--register", action="store_true", help="one-time Dynamic Client Registration (P0) and exit")
    p.add_argument("--force", action="store_true", help="with --register: re-register (new client_id)")
    p.add_argument("--action", choices=["read", "create"], default="read", help="read (default) or create a Jira ticket")
    p.add_argument("--project", help="Jira project key (overrides ATLASSIAN_XAA_PROJECT_KEY)")
    p.add_argument("--cloud-id", help="Jira site UUID / URL / name (overrides ATLASSIAN_XAA_CLOUD_ID)")
    p.add_argument("--env", default=str(ROOT / ".env"), help="path to the .env file (default: project .env)")
    p.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    p.add_argument("--prompt-login", action="store_true", help="force Okta re-authentication (prompt=login)")
    p.add_argument("--show-tokens", action="store_true", help="print raw tokens and secrets (local debugging only)")
    args = p.parse_args()
    SHOW_TOKENS = args.show_tokens

    load_env(Path(args.env))
    cfg = build_config(args)

    if args.register:
        register(cfg, args.force)
        return

    require(cfg, "atl_issuer")
    creds = load_credentials()
    if not creds:
        sys.exit("The agent isn't registered with Atlassian yet — run with --register first "
                 "(or set ATLASSIAN_XAA_CLIENT_ID / ATLASSIAN_XAA_CLIENT_SECRET).")
    print(f"Atlassian DCR client_id {creds['client_id']} (from {creds['source']})")

    id_token = login(cfg, open_browser=not args.no_browser, prompt_login=args.prompt_login)
    id_jag, claims = request_id_jag(cfg, id_token)
    check_id_jag(cfg, claims, creds)
    atl_token = redeem_at_atlassian(cfg, id_jag, creds)

    mcp = Mcp(cfg["mcp_url"], atl_token, first_step=4)
    mcp.initialize()
    cloud_id = resolve_site(cfg, mcp, atl_token, claims.get("aud_tenant"))
    (create_issue if args.action == "create" else read_issues)(cfg, mcp, cloud_id)


if __name__ == "__main__":
    main()
