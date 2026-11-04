import React from 'react';
import { login } from '../api.js';

export default function Login({ notice }) {
  return (
    <div className="login">
      <div className="login-card">
        {notice && <div className="login-notice">{notice}</div>}
        <h1>Okta for AI - Use Case Patterns</h1>
        <p>
          Sign in to chat with an agent that uses <strong>Okta Cross-App Access</strong>,{' '}
          <strong>Secrets</strong>, <strong>Service accounts</strong>, or{' '}
          <strong>Agent-to-Agent</strong> access to reach a protected API via MCP.
        </p>
        <button className="btn-primary" onClick={login}>
          Sign in with Okta
        </button>
      </div>
    </div>
  );
}
