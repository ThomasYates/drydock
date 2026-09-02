import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api.js';
import { SessionCtx } from './lib/session.js';
import { applyTheme, cachePrefs, cachedPrefs, DEFAULT_PREFS } from './lib/theme.js';
import { applyScale, cachedScale } from './lib/display.js';
import Auth from './components/Auth.jsx';
import Shell from './components/Shell.jsx';
import Projects from './components/Projects.jsx';
import ProjectView from './components/ProjectView.jsx';
import Admin from './components/Admin.jsx';
import Account from './components/Account.jsx';

// paint the last known look before anything renders, so there is no flash
applyTheme(cachedPrefs());
applyScale(cachedScale());

export default function App() {
  const [state, setState] = useState({ loading: true, initialised: true, user: null });
  const [prefs, setPrefsState] = useState(cachedPrefs);

  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/api/auth/state');
      setState({ loading: false, initialised: s.initialised, user: s.user, serverVersion: s.version });
      if (s.user?.prefs) {
        setPrefsState(s.user.prefs);
        applyTheme(s.user.prefs);
        cachePrefs(s.user.prefs);
      }
    } catch {
      setState({ loading: false, initialised: true, user: null, offline: true });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const setPrefs = useCallback(async (patch) => {
    const next = { ...DEFAULT_PREFS, ...patch };
    setPrefsState(next);
    applyTheme(next);
    cachePrefs(next);
    await api.post('/api/auth/prefs', next).catch(() => {});
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setState((s) => ({ ...s, user: null }));
  }, []);

  if (state.loading) {
    return <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}><div className="spin" /></div>;
  }

  if (!state.user) {
    return <Auth initialised={state.initialised} onDone={refresh} />;
  }

  return (
    <SessionCtx.Provider value={{ user: state.user, refresh, signOut, serverVersion: state.serverVersion, prefs, setPrefs }}>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<Projects />} />
          <Route path="/p/:projectId/*" element={<ProjectView />} />
          <Route path="/admin" element={state.user.isAdmin ? <Admin /> : <Navigate to="/" replace />} />
          <Route path="/account" element={<Account />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </SessionCtx.Provider>
  );
}
