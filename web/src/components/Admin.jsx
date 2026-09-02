import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Icon, Modal, useToast } from './ui.jsx';
import { UpdateDetails } from './UpdateBanner.jsx';
import { useUpdateStatus } from '../lib/updates.js';

export default function Admin() {
  const [users, setUsers] = useState([]);
  const [adding, setAdding] = useState(false);
  const [reset, setReset] = useState(null);
  const { user: me } = useSession();
  const say = useToast();

  const load = () => api.get('/api/auth/users').then((r) => setUsers(r.users));
  useEffect(() => { load().catch(() => {}); }, []);

  async function patch(u, body) {
    try { await api.patch(`/api/auth/users/${u.id}`, body); load(); }
    catch (e) { say(e.message); }
  }

  async function remove(u) {
    if (!confirm(`Delete ${u.displayName}? Their projects stay, but the account goes.`)) return;
    try { await api.del(`/api/auth/users/${u.id}`); load(); say('Account deleted'); }
    catch (e) { say(e.message); }
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 820 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 20 }}>
          <div>
            <p className="eyebrow">Admin</p>
            <h1>People &amp; settings</h1>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => setAdding(true)}><Icon.Plus /> Add person</button>
        </div>

        <p className="hint" style={{ marginTop: -8, marginBottom: 18 }}>
          There is no public sign-up. You create each account here and hand over the first password — they are asked to change it as soon as they sign in.
        </p>

        <div className="card" style={{ padding: 6 }}>
          <table className="list">
            <thead>
              <tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span className="peer" style={{ background: u.accent, width: 24, height: 24, borderWidth: 0 }}>
                        {u.displayName.slice(0, 1).toUpperCase()}
                      </span>
                      {u.displayName}{u.id === me.id && <span className="chip">You</span>}
                    </div>
                  </td>
                  <td className="mono hint">{u.username}</td>
                  <td>
                    <button className={`btn sm${u.isAdmin ? ' on' : ''}`} disabled={u.id === me.id}
                      onClick={() => patch(u, { isAdmin: !u.isAdmin })}>
                      {u.isAdmin ? 'Admin' : 'Member'}
                    </button>
                  </td>
                  <td>
                    {u.disabled
                      ? <span className="chip" style={{ color: 'var(--red)' }}>Disabled</span>
                      : u.mustChangePassword
                        ? <span className="chip" style={{ color: 'var(--brass)' }}>Pending first sign-in</span>
                        : <span className="chip" style={{ color: 'var(--green)' }}>Active</span>}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                      <button className="btn ghost sm" onClick={() => setReset(u)}>Reset password</button>
                      <button className="btn ghost sm" disabled={u.id === me.id} onClick={() => patch(u, { disabled: !u.disabled })}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button className="btn ghost icon sm" disabled={u.id === me.id} onClick={() => remove(u)}><Icon.Trash /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Updates />
      </div>

      {adding && <AddPerson onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {reset && <ResetPassword user={reset} onClose={() => setReset(null)} onDone={() => { setReset(null); load(); }} />}
    </div>
  );
}

/**
 * Drydock cannot replace its own container — that needs the Docker socket, and
 * mounting it here would make any bug in the app a way onto the host. So this
 * checks, and tells you what to run.
 */
function Updates() {
  const { status, checkNow } = useUpdateStatus({ poll: false });
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const say = useToast();

  async function check() {
    setBusy(true);
    try {
      const next = await checkNow();
      if (next.updateAvailable) say(`Drydock ${next.latest} is available`);
      else if (next.error) say(next.error);
      else say(`You are on the latest version (${next.current})`);
    } catch (e) {
      say(e.message);
    } finally {
      setBusy(false);
    }
  }

  const checked = status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : 'never';

  return (
    <div className="card" style={{ padding: 18, marginTop: 20 }}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ marginBottom: 6 }}>Version</h3>
          <p className="hint mono" style={{ margin: 0 }}>
            Running {status?.current || '…'}
            {status?.latest && status.latest !== status.current && ` · latest is ${status.latest}`}
          </p>
        </div>
        <button className="btn" onClick={check} disabled={busy || status?.enabled === false}>
          {busy ? <div className="spin" /> : <Icon.Target />} Check for updates
        </button>
      </div>

      {status?.enabled === false ? (
        <p className="hint" style={{ margin: '12px 0 0' }}>
          Update checks are switched off. Set <code>UPDATE_CHECK=1</code> in your compose file to
          turn them back on.
        </p>
      ) : (
        <>
          <p className="hint" style={{ margin: '12px 0 0' }}>
            Watching <span className="mono">{status?.repo || 'the release feed'}</span>. Last
            checked {checked}. Nothing is sent — it is one read of the public releases list.
          </p>

          {status?.error && <div className="error" style={{ marginTop: 12 }}>{status.error}</div>}

          {status?.updateAvailable && (
            <div className="update-callout">
              <div>
                <strong>Drydock {status.latest} is available.</strong>
                <p className="hint" style={{ margin: '3px 0 0' }}>
                  Two commands on the host and you are on it.
                </p>
              </div>
              <button className="btn primary sm" onClick={() => setShowDetails(true)}>
                <Icon.Download /> How to update
              </button>
            </div>
          )}

          {status && !status.updateAvailable && !status.error && status.checkedAt && (
            <p className="hint" style={{ margin: '10px 0 0', color: status.latest ? 'var(--green)' : undefined }}>
              {status.latest
                ? 'This is the newest release.'
                : 'That repository has not published a release yet, so there is nothing to compare against.'}
            </p>
          )}
        </>
      )}

      {showDetails && <UpdateDetails status={status} onClose={() => setShowDetails(false)} />}
    </div>
  );
}

function AddPerson({ onClose, onDone }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState(() => suggest());
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState('');
  const say = useToast();

  async function create() {
    try {
      await api.post('/api/auth/users', { username, displayName, password, isAdmin });
      say(`Account created — hand over the password to ${displayName || username}`);
      onDone();
    } catch (e) { setError(e.message); }
  }

  return (
    <Modal title="Add a person" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={create}>Create account</button>
      </>}>
      <div className="field">
        <label>Username</label>
        <input className="input" value={username} autoFocus autoCapitalize="none" onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="field">
        <label>Display name</label>
        <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div className="field">
        <label>First password</label>
        <div className="row">
          <input className="input mono" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn" onClick={() => setPassword(suggest())}>Suggest</button>
        </div>
        <span className="hint">They will be asked to replace this the first time they sign in.</span>
      </div>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} style={{ accentColor: 'var(--brass)' }} />
        Can manage people and delete projects
      </label>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

function ResetPassword({ user, onClose, onDone }) {
  const [password, setPassword] = useState(() => suggest());
  const [error, setError] = useState('');
  const say = useToast();

  async function go() {
    try {
      await api.patch(`/api/auth/users/${user.id}`, { password });
      say('Password reset — they are signed out everywhere');
      onDone();
    } catch (e) { setError(e.message); }
  }

  return (
    <Modal title={`Reset password for ${user.displayName}`} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={go}>Reset password</button>
      </>}>
      <div className="field">
        <label>New password</label>
        <div className="row">
          <input className="input mono" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn" onClick={() => setPassword(suggest())}>Suggest</button>
        </div>
      </div>
      <p className="hint" style={{ margin: 0 }}>This ends all their open sessions and asks them to choose a new password on next sign-in.</p>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

function suggest() {
  const words = ['harbour', 'lantern', 'quiet', 'orbit', 'vessel', 'signal', 'drift', 'anchor', 'ember', 'static', 'hollow', 'compass'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 9000 + 1000)}`;
}
