import { useCallback, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../lib/session.js';
import { api } from '../lib/api.js';
import { Icon, Modal, useToast } from './ui.jsx';
import { ACCENTS } from '../lib/theme.js';
import { FONTS, DEFAULT_FONT, fontStack } from '../lib/fonts.js';
import { applyScale, cachedScale, stepScale, SCALES } from '../lib/display.js';
import Search, { useSearchShortcut } from './Search.jsx';
import UpdateBanner from './UpdateBanner.jsx';
import { useUpdateStatus } from '../lib/updates.js';

export default function Shell() {
  const { user, signOut, refresh, serverVersion, prefs, setPrefs } = useSession();
  const [look, setLook] = useState(false);
  const build = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  const stale = serverVersion && serverVersion !== build;
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const loc = useLocation();
  const inProject = loc.pathname.startsWith('/p/');
  const projectId = inProject ? loc.pathname.split('/')[2] : null;

  const { status: update, dismiss, showBanner } = useUpdateStatus();

  const openSearch = useCallback(() => setSearching(true), []);
  useSearchShortcut(openSearch);

  return (
    <div className="app">
      {user.mustChangePassword && <ForcePassword onDone={refresh} />}
      {showBanner && <UpdateBanner status={update} onDismiss={dismiss} />}
      <header className="topbar">
        <Link to="/" className="wordmark"><Icon.Mark /><span>Drydock</span></Link>
        {!inProject && <div className="tabs"><span className="eyebrow">Projects</span></div>}
        <div id="topbar-slot" style={{ display: 'contents' }} />
        <div className="spacer" />

        <button className="btn ghost search-trigger" onClick={openSearch}
          title="Search everything (Ctrl+K)" aria-label="Search everything">
          <Icon.Zoom />
          <span className="label">Search</span>
          <kbd className="mono">Ctrl K</kbd>
        </button>

        <div style={{ position: 'relative' }}>
          <button className={`btn ghost icon${look ? ' on' : ''}`} onClick={() => setLook((v) => !v)}
            title="Appearance" aria-label="Appearance"><Icon.Gear /></button>
          {look && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setLook(false)} />
              <Appearance prefs={prefs} setPrefs={setPrefs} />
            </>
          )}
        </div>

        <div style={{ position: 'relative' }}>
          <button className="btn ghost" onClick={() => setMenu((m) => !m)}>
            <span className="peer" style={{ background: user.accent, width: 20, height: 20, borderWidth: 0 }}>
              {user.displayName.slice(0, 1).toUpperCase()}
            </span>
            {user.displayName}
          </button>
          {menu && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setMenu(false)} />
              <div className="card" style={{ position: 'absolute', right: 0, top: 38, width: 190, padding: 5, zIndex: 41 }}>
                <Link className="tab" style={{ width: '100%' }} to="/account" onClick={() => setMenu(false)}><Icon.User /> Account</Link>
                {user.isAdmin && <Link className="tab" style={{ width: '100%' }} to="/admin" onClick={() => setMenu(false)}><Icon.Users /> People</Link>}
                <button className="tab" style={{ width: '100%' }} onClick={signOut}><Icon.Back /> Sign out</button>
                <div style={{ borderTop: '1px solid var(--line-soft)', margin: '5px 0 0', padding: '7px 11px 3px' }}>
                  <span className="eyebrow">Drydock v{build}</span>
                  {stale && (
                    <p className="hint" style={{ margin: '4px 0 0', color: 'var(--brass)', fontSize: 11 }}>
                      The server is running v{serverVersion}. Reload to pick up the new frontend.
                    </p>
                  )}
                  {update?.updateAvailable && (
                    <p className="hint" style={{ margin: '4px 0 0', color: 'var(--brass)', fontSize: 11 }}>
                      v{update.latest} is available.
                      {user.isAdmin && <> See <Link to="/admin">People &amp; settings</Link>.</>}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </header>
      <div className="body"><Outlet /></div>

      <Search
        open={searching}
        onClose={() => setSearching(false)}
        projectId={projectId}
      />
    </div>
  );
}

function Appearance({ prefs, setPrefs }) {
  const [custom, setCustom] = useState(prefs.accent);
  const [scale, setScale] = useState(cachedScale);

  const nudge = (direction) => setScale(applyScale(stepScale(scale, direction)));

  return (
    <div className="card appearance" role="dialog" aria-label="Appearance">
      <div className="sec">
        <span className="eyebrow">Mode</span>
        <div className="seg">
          <button className={prefs.theme === 'dark' ? 'on' : ''}
            onClick={() => setPrefs({ ...prefs, theme: 'dark' })}>
            <Icon.Moon /> Dark
          </button>
          <button className={prefs.theme === 'light' ? 'on' : ''}
            onClick={() => setPrefs({ ...prefs, theme: 'light' })}>
            <Icon.Sun /> Light
          </button>
        </div>
      </div>

      <div className="sec">
        <div className="row between">
          <span className="eyebrow">Interface scale</span>
          <span className="mono hint">{Math.round(scale * 100)}%</span>
        </div>
        <div className="scale-row">
          <button className="btn sm icon" onClick={() => nudge(-1)}
            disabled={scale <= SCALES[0]} aria-label="Smaller">−</button>
          <div className="scale-track" aria-hidden="true">
            {SCALES.map((s) => (
              <span key={s} className={`pip${s === scale ? ' on' : ''}`} />
            ))}
          </div>
          <button className="btn sm icon" onClick={() => nudge(1)}
            disabled={scale >= SCALES[SCALES.length - 1]} aria-label="Bigger">+</button>
          <button className="btn sm" onClick={() => setScale(applyScale(1))} disabled={scale === 1}>Reset</button>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Kept on this device rather than your account, since the right size on a big monitor is the
          wrong size on a laptop.
        </p>
      </div>

      <div className="sec">
        <span className="eyebrow">Interface typeface</span>
        <select
          className="input"
          value={prefs.uiFont || DEFAULT_FONT}
          style={{ fontFamily: fontStack(prefs.uiFont || DEFAULT_FONT) }}
          onChange={(e) => setPrefs({ ...prefs, uiFont: e.target.value })}
        >
          {FONTS.map((f) => (
            <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>{f.name} · {f.kind}</option>
          ))}
        </select>
        <p className="hint" style={{ margin: 0 }}>
          Everything except notes on a moodboard — those keep whatever typeface you gave them.
        </p>
      </div>

      <div className="sec">
        <span className="eyebrow">Secondary colour</span>
        <div className="swatches">
          {ACCENTS.map((a) => (
            <button
              key={a.value}
              className={`swatch${prefs.accent.toLowerCase() === a.value.toLowerCase() ? ' on' : ''}`}
              style={{ background: a.value }}
              title={a.name}
              aria-label={a.name}
              onClick={() => { setCustom(a.value); setPrefs({ ...prefs, accent: a.value }); }}
            />
          ))}
        </div>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="color"
            className="colour-well"
            value={custom}
            onChange={(e) => { setCustom(e.target.value); setPrefs({ ...prefs, accent: e.target.value }); }}
          />
          <span className="hint mono">{custom.toUpperCase()}</span>
        </label>
        <p className="hint" style={{ margin: 0 }}>
          Used for anything selected or active. Saved to your account, so it follows you between machines.
        </p>
      </div>
    </div>
  );
}

function ForcePassword({ onDone }) {
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const say = useToast();

  async function save() {
    if (next !== confirm) { setError('The two passwords do not match'); return; }
    try {
      await api.post('/api/auth/password', { next });
      say('Password changed');
      await onDone();
    } catch (e) { setError(e.message); }
  }

  return (
    <Modal title="Choose your own password" onClose={() => {}}
      footer={<button className="btn primary" onClick={save}>Save password</button>}>
      <p className="hint" style={{ margin: 0 }}>An admin set this account up. Pick a password only you know before carrying on.</p>
      <div className="field">
        <label>New password</label>
        <input type="password" className="input" value={next} autoFocus onChange={(e) => setNext(e.target.value)} />
      </div>
      <div className="field">
        <label>Confirm</label>
        <input type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
