import React, { useEffect, useState } from 'react';
import { getMe, logout, login, a2aLogin, webappLogin, authpLogin } from './api.js';
import { FLOWS } from './flows.js';
import { isForceLogin, supportsForceLogin, startFlowLogin } from './forceLogin.js';
import Login from './components/Login.jsx';
import Home from './components/Home.jsx';
import Chat from './components/Chat.jsx';
import SamlSetup from './components/SamlSetup.jsx';

export default function App() {
  const [state, setState] = useState({ loading: true });
  const [flowId, setFlowId] = useState(null); // null = home

  async function refresh() {
    const me = await getMe();
    setState({ loading: false, ...me });
    return me;
  }

  useEffect(() => {
    // Returning from a login carrying ?flow=... opens that flow once its auth context is met.
    const params = new URLSearchParams(window.location.search);
    const urlFlow = params.get('flow');
    if (params.toString()) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    refresh().then((me) => {
      if (urlFlow && FLOWS[urlFlow]) {
        const f = FLOWS[urlFlow];
        const ok =
          f.authContext === 'authp'
            ? me.authp?.[f.authPattern]?.authenticated
            : f.authContext === 'a2a'
            ? me.a2aAuthenticated
            : f.authContext === 'saml'
            ? me.samlAuthenticated
            : f.authContext === 'webapp'
            ? me.webappAuthenticated
            : me.authenticated;
        if (ok) setFlowId(urlFlow);
      }
    });
  }, []);

  // Called when a flow's subject token has expired: the server has already destroyed
  // the session; logout() is idempotent and also clears anything left client-side.
  async function handleSessionExpired(message) {
    await logout();
    setFlowId(null);
    setState({ loading: false, authenticated: false, authp: {}, notice: message });
  }

  async function handleLogout() {
    await logout();
    setFlowId(null);
    setState({
      loading: false,
      authenticated: false,
      a2aAuthenticated: false,
      samlAuthenticated: false,
      webappAuthenticated: false,
      authp: {},
    });
  }

  if (state.loading) {
    return <div className="app-loading">Loading…</div>;
  }

  // Entry to the app is the regular login (single button). A2A flows then initiate
  // their own login (separate client) when selected.
  const flow = flowId ? FLOWS[flowId] : null;

  function selectFlow(id) {
    const f = FLOWS[id];
    // Force login is on for this flow: always re-run its /authorize with prompt=login,
    // even though a session exists. The return trip (?flow=id) opens the flow directly
    // via the effect above, so this does not loop.
    if (supportsForceLogin(f) && isForceLogin(id)) return startFlowLogin(f, { force: true });
    if (f.authContext === 'a2a') {
      if (!state.a2aAuthenticated) return a2aLogin(id);
    }
    if (f.authContext === 'authp') {
      // Each authentication-pattern agent logs the user in itself ("login as agent").
      if (!state.authp?.[f.authPattern]?.authenticated) return authpLogin(f.authPattern, id);
    }
    if (f.authContext === 'webapp') {
      if (!state.webappAuthenticated) return webappLogin(id);
    }
    // SAML opens the flow directly; the SamlSetup panel handles paste-or-IdP login.
    setFlowId(id);
  }

  const isA2a = flow?.authContext === 'a2a';
  const isSaml = flow?.authContext === 'saml';
  const isWebapp = flow?.authContext === 'webapp';
  const authp = flow?.authContext === 'authp' ? state.authp?.[flow.authPattern] : null;
  const displayUser = authp
    ? authp.user || state.user
    : isA2a
    ? state.a2aUser || state.user
    : isSaml
    ? state.samlUser || state.user
    : isWebapp
    ? state.webappUser || state.user
    : state.user;

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          {state.authenticated && flow && (
            <button className="btn-ghost" onClick={() => setFlowId(null)}>
              ← Home
            </button>
          )}
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">Okta for AI</span>
          <span className="brand-sub">{flow ? flow.name : 'Use Case Patterns'}</span>
        </div>
        </div>
        {state.authenticated && (
          <div className="header-user">
            <span>{displayUser?.name || displayUser?.email || displayUser?.sub || ''}</span>
            <button className="btn-ghost" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {!state.authenticated && <Login notice={state.notice} />}
      {state.authenticated && !flow && <Home onSelect={selectFlow} authp={state.authp} />}
      {state.authenticated && flow && isSaml && !state.samlAuthenticated && (
        <SamlSetup flow={flow} onReady={refresh} />
      )}
      {state.authenticated && flow && !(isSaml && !state.samlAuthenticated) && (
        <Chat
          key={flow.id}
          flow={flow}
          onSessionExpired={handleSessionExpired}
          loginStep={
            authp ? authp.loginStep : isA2a ? state.a2aLoginStep : isSaml ? state.samlLoginStep : isWebapp ? state.webappLoginStep : state.loginStep
          }
        />
      )}
    </div>
  );
}
