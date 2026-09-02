import { useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './ui.jsx';

export default function Auth({ initialised, onDone }) {
  const setup = !initialised;
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (setup && password !== confirm) { setError('The two passwords do not match'); return; }
    setBusy(true);
    try {
      if (setup) await api.post('/api/auth/setup', { username, displayName, password });
      else await api.post('/api/auth/login', { username, password });
      await onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card card" onSubmit={submit}>
        <div className="auth-mark">
          <Icon.Mark />
          <span className="name">Drydock</span>
        </div>
        <p className="eyebrow" style={{ marginBottom: 20 }}>
          {setup ? 'First run · create the admin account' : 'Game design workspace'}
        </p>

        <div className="stack">
          {setup && (
            <p className="hint" style={{ margin: 0 }}>
              This is the only account that can be created without signing in. Everyone else gets added from the admin page.
            </p>
          )}

          <div className="field">
            <label htmlFor="u">Username</label>
            <input id="u" className="input" value={username} autoFocus autoCapitalize="none"
              autoComplete="username" onChange={(e) => setUsername(e.target.value)} required />
          </div>

          {setup && (
            <div className="field">
              <label htmlFor="d">Display name</label>
              <input id="d" className="input" value={displayName} placeholder="Shown to collaborators"
                onChange={(e) => setDisplayName(e.target.value)} />
            </div>
          )}

          <div className="field">
            <label htmlFor="p">Password</label>
            <input id="p" type="password" className="input" value={password}
              autoComplete={setup ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)} required />
            {setup && <span className="hint">At least 10 characters.</span>}
          </div>

          {setup && (
            <div className="field">
              <label htmlFor="p2">Confirm password</label>
              <input id="p2" type="password" className="input" value={confirm}
                autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} required />
            </div>
          )}

          {error && <div className="error">{error}</div>}

          <button className="btn primary" style={{ height: 38, justifyContent: 'center' }} disabled={busy}>
            {busy ? <div className="spin" /> : (setup ? 'Create admin account' : 'Sign in')}
          </button>
        </div>
      </form>
    </div>
  );
}
