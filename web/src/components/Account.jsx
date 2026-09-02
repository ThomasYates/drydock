import { useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useToast } from './ui.jsx';

const ACCENTS = ['#e2a445', '#59c2d6', '#6fbf8b', '#e0685f', '#9a8cf0', '#d98cc0', '#8fb3e0'];

export default function Account() {
  const { user, refresh } = useSession();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [accent, setAccent] = useState(user.accent);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const say = useToast();

  async function saveProfile() {
    await api.post('/api/auth/profile', { displayName, accent });
    say('Profile saved');
    refresh();
  }

  async function savePassword() {
    setError('');
    if (next !== confirm) { setError('The two passwords do not match'); return; }
    try {
      await api.post('/api/auth/password', { current, next });
      setCurrent(''); setNext(''); setConfirm('');
      say('Password changed — other sessions signed out');
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 560 }}>
        <p className="eyebrow">Signed in as {user.username}</p>
        <h1 style={{ marginBottom: 22 }}>Account</h1>

        <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h3>Profile</h3>
          <div className="field">
            <label>Display name</label>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label>Your colour on shared boards</label>
            <div className="swatches">
              {ACCENTS.map((c) => (
                <button key={c} className={`swatch${accent === c ? ' on' : ''}`} style={{ background: c }}
                  aria-label={`Accent ${c}`} onClick={() => setAccent(c)} />
              ))}
            </div>
          </div>
          <div><button className="btn primary" onClick={saveProfile}>Save profile</button></div>
        </div>

        <div className="card" style={{ padding: 18, marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h3>Password</h3>
          <div className="field">
            <label>Current password</label>
            <input type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="field">
            <label>New password</label>
            <input type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div className="field">
            <label>Confirm new password</label>
            <input type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {error && <div className="error">{error}</div>}
          <div><button className="btn primary" onClick={savePassword}>Change password</button></div>
        </div>
      </div>
    </div>
  );
}
