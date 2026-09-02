import { useCallback, useEffect, useState } from 'react';
import { api, humanBytes } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useRoom } from '../lib/realtime.js';
import { Empty, Icon, Modal, useToast } from './ui.jsx';

const KIND_COLOUR = {
  'item.delete': 'var(--red)', 'card.delete': 'var(--red)', 'node.delete': 'var(--red)',
  'edge.delete': 'var(--red)', 'image.delete': 'var(--red)', 'column.delete': 'var(--red)',
  'graph.delete': 'var(--red)', 'snapshot.delete': 'var(--red)',
  'project.restore': 'var(--violet)', 'snapshot.create': 'var(--cyan)',
  'item.create': 'var(--green)', 'card.create': 'var(--green)', 'node.create': 'var(--green)',
  'image.upload': 'var(--green)', 'edge.create': 'var(--green)', 'column.create': 'var(--green)',
  'graph.create': 'var(--green)', 'project.create': 'var(--green)',
};

const REASON = {
  manual: { label: 'Saved by hand', colour: 'var(--brass)' },
  auto: { label: 'Automatic', colour: 'var(--cyan)' },
  'pre-restore': { label: 'Safety copy', colour: 'var(--violet)' },
};

export default function History({ projectId, onRestored }) {
  const [events, setEvents] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [tab, setTab] = useState('activity');
  const [confirming, setConfirming] = useState(null);
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { user } = useSession();
  const say = useToast();

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      api.get(`/api/history/${projectId}/events`),
      api.get(`/api/history/${projectId}/snapshots`),
    ]);
    setEvents(a.events);
    setSnapshots(b.snapshots);
  }, [projectId]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  useRoom(`project:${projectId}`, {
    onResync: load,
    onOp: (op) => {
      if (op.kind === 'history.event') {
        setEvents((s) => [op.event, ...s.filter((e) => e.id !== op.event.id)]);
      } else if (op.kind === 'project.restored') {
        load();
      }
    },
  });

  async function save(label) {
    setBusy(true);
    try {
      await api.post(`/api/history/${projectId}/snapshots`, { label });
      await load();
      say('Restore point saved');
      setNaming(false);
    } catch (e) { say(e.message); } finally { setBusy(false); }
  }

  async function restore(snapshot) {
    setBusy(true);
    try {
      const r = await api.post(`/api/history/snapshots/${snapshot.id}/restore`);
      await load();
      setConfirming(null);
      say(`Restored — ${r.counts.items} board items, ${r.counts.cards} cards, ${r.counts.nodes} beats`);
      onRestored?.();
    } catch (e) { say(e.message); } finally { setBusy(false); }
  }

  async function remove(snapshot) {
    if (!confirm(`Delete the restore point “${snapshot.label}”? The project itself is untouched.`)) return;
    await api.del(`/api/history/snapshots/${snapshot.id}`);
    load();
    say('Restore point deleted');
  }

  const undoTarget = (event) => snapshots.find((s) => s.id === event.detail?.safetyId);

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 860 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 18 }}>
          <div>
            <p className="eyebrow">Who changed what, and how to get it back</p>
            <h1>History</h1>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy} onClick={() => setNaming(true)}>
            <Icon.Plus /> Save a restore point
          </button>
        </div>

        <div className="tabs" style={{ marginBottom: 16 }}>
          <button className={`tab${tab === 'activity' ? ' active' : ''}`} onClick={() => setTab('activity')}>
            Activity
          </button>
          <button className={`tab${tab === 'snapshots' ? ' active' : ''}`} onClick={() => setTab('snapshots')}>
            Restore points <span className="chip" style={{ marginLeft: 6 }}>{snapshots.length}</span>
          </button>
        </div>

        {tab === 'activity' && (
          events.length === 0
            ? <Empty title="Nothing has happened yet" hint="Every change to this project shows up here as it happens." />
            : (
              <ol className="feed">
                {events.map((e) => (
                  <li key={e.id}>
                    <span className="dot" style={{ background: KIND_COLOUR[e.kind] || 'var(--dim)' }} />
                    <div className="what">
                      <span>{e.summary}</span>
                      {e.tally > 1 && <span className="chip">×{e.tally}</span>}
                      {e.kind === 'project.restore' && undoTarget(e) && user.isAdmin && (
                        <button className="btn sm" onClick={() => setConfirming({ ...undoTarget(e), undoing: true })}>
                          <Icon.Back /> Undo this restore
                        </button>
                      )}
                    </div>
                    <span className="who mono">{e.user_name}</span>
                    <time className="mono" dateTime={e.created_at}>{when(e.created_at)}</time>
                  </li>
                ))}
              </ol>
            )
        )}

        {tab === 'snapshots' && (
          <>
            <p className="hint" style={{ margin: '0 0 14px' }}>
              A restore point is a full copy of the project: boards, images, cards and story. One is written
              automatically before any large deletion and once a day while the project is being worked on.
              {!user.isAdmin && ' Only an admin can restore one.'}
            </p>
            {snapshots.length === 0
              ? <Empty title="No restore points yet" hint="Save one before a big rearrangement, or let the automatic ones build up." />
              : (
                <div className="card" style={{ padding: 6 }}>
                  <table className="list">
                    <thead>
                      <tr><th>Restore point</th><th>Holds</th><th>Kind</th><th>When</th><th /></tr>
                    </thead>
                    <tbody>
                      {snapshots.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <div style={{ fontWeight: 500 }}>{s.label}</div>
                            <div className="hint mono" style={{ fontSize: 11 }}>{s.created_by_name} · {humanBytes(s.bytes)}</div>
                          </td>
                          <td className="mono hint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                            {s.counts.items ?? 0} items<br />
                            {s.counts.cards ?? 0} cards · {s.counts.nodes ?? 0} beats
                          </td>
                          <td>
                            <span className="chip" style={{ color: REASON[s.reason]?.colour }}>
                              {REASON[s.reason]?.label || s.reason}
                            </span>
                          </td>
                          <td className="mono hint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{when(s.created_at)}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                              <button className="btn sm" disabled={!user.isAdmin || busy}
                                title={user.isAdmin ? 'Put the project back to this point' : 'Only an admin can restore'}
                                onClick={() => setConfirming(s)}>Restore</button>
                              <button className="btn ghost icon sm" disabled={!user.isAdmin} onClick={() => remove(s)}>
                                <Icon.Trash />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </>
        )}
      </div>

      {naming && <NameSnapshot onClose={() => setNaming(false)} onSave={save} busy={busy} />}

      {confirming && (
        <Modal
          title={confirming.undoing ? 'Undo that restore?' : `Restore “${confirming.label}”?`}
          onClose={() => setConfirming(null)}
          footer={<>
            <button className="btn ghost" onClick={() => setConfirming(null)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={() => restore(confirming)}>
              {busy ? <div className="spin" /> : confirming.undoing ? 'Undo the restore' : 'Restore the project'}
            </button>
          </>}>
          <p style={{ margin: 0 }}>
            This replaces everything in the project — boards, images, cards and story — with the copy taken{' '}
            {when(confirming.created_at)}.
          </p>
          <div className="card" style={{ padding: 12, background: 'var(--panel-2)' }}>
            <span className="eyebrow">That copy holds</span>
            <div className="mono" style={{ marginTop: 4 }}>
              {confirming.counts.items ?? 0} board items · {confirming.counts.images ?? 0} images ·{' '}
              {confirming.counts.cards ?? 0} cards · {confirming.counts.nodes ?? 0} beats
            </div>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            A safety copy of how things look right now is written first, so this is reversible.
            Anyone with the project open will see it reload.
          </p>
        </Modal>
      )}
    </div>
  );
}

function NameSnapshot({ onClose, onSave, busy }) {
  const [label, setLabel] = useState('');
  return (
    <Modal title="Save a restore point" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={() => onSave(label)}>Save restore point</button>
      </>}>
      <div className="field">
        <label>Name it (optional)</label>
        <input className="input" value={label} autoFocus placeholder="Before reworking act two"
          onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSave(label)} />
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Copies the whole project as it stands. Cheap to keep — a few kilobytes plus whatever images it points at.
      </p>
    </Modal>
  );
}

function when(iso) {
  const then = new Date(iso);
  const secs = (Date.now() - then.getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)}d ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
