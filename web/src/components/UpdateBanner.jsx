import { useState } from 'react';
import { Icon, Modal, useToast } from './ui.jsx';
import { UPDATE_COMMANDS } from '../lib/updates.js';

/**
 * A strip across the top when a newer release exists.
 *
 * Drydock cannot update itself — that would mean handing the web app the
 * Docker socket, and any bug in here would then be root on the host. So the
 * honest offer is: here is what changed, and here are the two lines that take
 * it. Tucking it away is remembered per device until the next release.
 */
export default function UpdateBanner({ status, onDismiss }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="update-bar" role="status">
        <span className="dot" aria-hidden="true" />
        <span className="msg">
          <strong>Drydock {status.latest} is out.</strong>
          {' '}You are running {status.current}. Would you like to update?
        </span>
        <button className="btn sm primary" onClick={() => setOpen(true)}>
          <Icon.Download /> Yes, show me how
        </button>
        <button className="btn sm ghost" onClick={onDismiss}>Not now</button>
      </div>
      {open && <UpdateDetails status={status} onClose={() => setOpen(false)} />}
    </>
  );
}

export function UpdateDetails({ status, onClose }) {
  const say = useToast();
  const release = status.release || {};

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(UPDATE_COMMANDS);
      say('Commands copied');
    } catch {
      say('Your browser would not let us copy — select the text instead');
    }
  };

  return (
    <Modal
      title={`Update to ${status.latest}`}
      onClose={onClose}
      wide
      footer={(
        <>
          {release.url && (
            <a className="btn ghost" href={release.url} target="_blank" rel="noreferrer">
              Release on GitHub
            </a>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={copy}><Icon.Copy /> Copy the commands</button>
        </>
      )}
    >
      <p className="hint" style={{ margin: 0 }}>
        Run these two lines on the machine hosting Drydock, in the folder holding your
        <code> compose.yaml</code>. The first pulls the new image, the second swaps the
        container over. Your <code>/data</code> volume is untouched, so nothing is lost.
      </p>

      <pre className="mono cmd" style={{ whiteSpace: 'pre-line' }}>{UPDATE_COMMANDS}</pre>

      <p className="hint" style={{ margin: 0 }}>
        Using Dockge or Portainer? Their <strong>Update</strong> button does exactly this.
      </p>

      {release.notes && (
        <div className="release-notes">
          <span className="eyebrow">What changed</span>
          {/* release notes are plain text on purpose — nothing from GitHub is rendered as markup */}
          <pre>{release.notes}</pre>
        </div>
      )}

      {release.publishedAt && (
        <p className="hint mono" style={{ margin: 0 }}>
          Published {new Date(release.publishedAt).toLocaleDateString()}
        </p>
      )}
    </Modal>
  );
}
