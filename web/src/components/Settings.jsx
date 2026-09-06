import { useEffect, useState } from 'react';
import { useSession } from '../lib/session.js';
import { useToast } from './ui.jsx';

const DEFAULT_GLIDE = 45;

const STOPS = [
  { at: 0, label: 'Stops dead' },
  { at: DEFAULT_GLIDE, label: 'Default' },
  { at: 100, label: 'Full drift' },
];

/** Roughly how it will feel, so the number means something before you try it. */
function describe(value) {
  if (value === 0) return 'A flick stops the moment your fingers leave the trackpad.';
  if (value < 30) return 'Pulls up quickly after a flick.';
  if (value < 65) return 'Drifts on a little, then settles.';
  if (value < 95) return 'Keeps gliding for a while after a flick.';
  return 'The full macOS coast, which on an infinite canvas travels a long way.';
}

export default function Settings() {
  const { prefs, setPrefs } = useSession();
  const say = useToast();
  const saved = prefs.trackpadGlide ?? DEFAULT_GLIDE;
  const [glide, setGlide] = useState(saved);

  // if it changes in another tab, follow it rather than sitting on a stale draft
  useEffect(() => { setGlide(saved); }, [saved]);

  const dirty = glide !== saved;

  function save() {
    setPrefs({ ...prefs, trackpadGlide: glide });
    say('Applied');
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 560 }}>
        <p className="eyebrow">Just for you — everyone else keeps their own</p>
        <h1 style={{ marginBottom: 22 }}>Settings</h1>

        <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h3>Trackpad</h3>
          <p className="hint" style={{ margin: 0 }}>
            After a quick flick, a moodboard or a story graph carries on drifting
            once your fingers have left the trackpad. This sets how much of that
            drift to keep. Deliberate swipes and slow adjustments are not
            affected at any setting, and neither is a mouse wheel.
          </p>

          <div className="field">
            <label htmlFor="glide">
              Drift after a flick
              <span style={{ float: 'right', color: 'var(--brass)' }} className="mono">{glide}%</span>
            </label>
            <input
              id="glide"
              type="range"
              min="0"
              max="100"
              step="5"
              value={glide}
              onChange={(e) => setGlide(Number(e.target.value))}
            />
            <div className="scale-marks">
              {STOPS.map((s) => (
                <button key={s.at} className={glide === s.at ? 'on' : ''}
                  onClick={() => setGlide(s.at)}>{s.label}</button>
              ))}
            </div>
          </div>

          <p className="hint" style={{ margin: 0 }}>{describe(glide)}</p>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn primary" onClick={save} disabled={!dirty}>Save</button>
            {glide !== DEFAULT_GLIDE && (
              <button className="btn" onClick={() => setGlide(DEFAULT_GLIDE)}>Reset to default</button>
            )}
            {dirty && <span className="hint">Saved setting is {saved}%.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
