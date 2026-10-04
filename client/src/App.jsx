import React, { useEffect, useState } from 'react';
import { getMe, logout, login, a2aLogin, webappLogin } from './api.js';
import { FLOWS } from './flows.js';
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
          f.authContext === 'a2a'
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

  async function handleLogout() {
    await logout();
    setFlowId(null);
    setState({
      loading: false,
      authenticated: false,
      a2aAuthenticated: false,
      samlAuthenticated: false,
      webappAuthenticated: false,
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
    if (f.authContext === 'a2a') {
      if (!state.a2aAuthenticated) return a2aLogin(id);
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
  const displayUser = isA2a
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

      {!state.authenticated && <Login />}
      {state.authenticated && !flow && <Home onSelect={selectFlow} />}
      {state.authenticated && flow && isSaml && !state.samlAuthenticated && (
        <SamlSetup flow={flow} onReady={refresh} />
      )}
      {state.authenticated && flow && !(isSaml && !state.samlAuthenticated) && (
        <Chat
          key={flow.id}
          flow={flow}
          loginStep={
            isA2a ? state.a2aLoginStep : isSaml ? state.samlLoginStep : isWebapp ? state.webappLoginStep : state.loginStep
          }
        />
      )}
    </div>
  );
}
