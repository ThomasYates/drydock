import { useState } from 'react';
import { Icon } from './ui.jsx';
import { looksLikeAPhone, mobileWarningSeen, rememberMobileWarning } from '../lib/display.js';

/**
 * Drydock is built around a mouse and a keyboard — infinite canvases, drag to
 * link, right-click menus, keyboard shortcuts. On a phone most of that either
 * does not work or is miserable, so say so plainly rather than let someone
 * discover it one broken gesture at a time.
 */
export default function MobileGate({ children }) {
  const [blocked, setBlocked] = useState(() => looksLikeAPhone() && !mobileWarningSeen());

  if (!blocked) return children;

  return (
    <div className="mobile-gate">
      <div className="mobile-gate-inner">
        <div className="auth-mark">
          <Icon.Mark />
          <span className="name">Drydock</span>
        </div>

        <h1>This is not built for phones</h1>

        <p>
          Drydock is a desktop tool. The moodboard and story canvases expect a mouse: panning with the
          middle button, dragging links between nodes, right-click menus and keyboard shortcuts. On a
          small touch screen most of that either will not work or will be a fight.
        </p>

        <ul>
          <li>Dragging to link story nodes needs a precise pointer</li>
          <li>Right-click menus have no touch equivalent</li>
          <li>The inspector panels leave almost no room for the canvas</li>
        </ul>

        <p className="hint">
          Reading and light editing will mostly work. Anything on a canvas will not.
        </p>

        <button
          className="btn primary"
          onClick={() => { rememberMobileWarning(); setBlocked(false); }}
        >
          Carry on anyway
        </button>

        <p className="hint" style={{ marginBottom: 0 }}>
          Asked once per device. Clear your browser data for this site to see it again.
        </p>
      </div>
    </div>
  );
}
