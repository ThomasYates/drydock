import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { api, mediaUrl } from '../lib/api.js';
import { Icon, Modal, useToast } from './ui.jsx';
import { useSession } from '../lib/session.js';
import Moodboard from './Moodboard.jsx';
import Kanban from './Kanban.jsx';
import Story from './Story.jsx';
import Assets from './Assets.jsx';
import History from './History.jsx';
import { useRoom } from '../lib/realtime.js';

export default function ProjectView() {
  const { projectId } = useParams();
  const [data, setData] = useState(null);
  const [gone, setGone] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const load = useCallback(async () => {
    try { setData(await api.get(`/api/projects/${projectId}`)); }
    catch { setGone(true); }
  }, [projectId]);

  useEffect(() => { setData(null); load(); }, [load]);

  // a restore rebuilds everything, so remount the tabs underneath
  const reload = useCallback(() => { setEpoch((n) => n + 1); load(); }, [load]);
  useRoom(`project:${projectId}`, {
    onOp: (op) => { if (op.kind === 'project.restored') reload(); },
  });

  if (gone) return <Navigate to="/" replace />;
  if (!data) return <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}><div className="spin" /></div>;

  return (
    <>
      <Tabs project={data.project} />
      <Routes key={epoch}>
        <Route index element={<Navigate to="moodboard" replace />} />
        <Route path="moodboard" element={<Moodboard projectId={projectId} boardId={data.rootBoardId} />} />
        <Route path="moodboard/:boardId" element={<MoodboardRoute projectId={projectId} />} />
        <Route path="tasks" element={<Kanban projectId={projectId} />} />
        <Route path="story" element={<Story projectId={projectId} />} />
        <Route path="story/:graphId" element={<Story projectId={projectId} />} />
        <Route path="assets" element={<Assets projectId={projectId} />} />
        <Route path="history" element={<History projectId={projectId} onRestored={reload} />} />
        <Route path="settings" element={<Settings project={data.project} onChange={load} />} />
        <Route path="*" element={<Navigate to="moodboard" replace />} />
      </Routes>
    </>
  );
}

function MoodboardRoute({ projectId }) {
  const { boardId } = useParams();
  return <Moodboard projectId={projectId} boardId={boardId} />;
}

function Tabs({ project }) {
  const [slot, setSlot] = useState(null);
  useEffect(() => { setSlot(document.getElementById('topbar-slot')); }, []);
  if (!slot) return null;
  const base = `/p/${project.id}`;
  const cls = ({ isActive }) => `tab${isActive ? ' active' : ''}`;
  return createPortal(
    <>
      <span style={{ color: 'var(--dim)' }}>/</span>
      <strong style={{ fontWeight: 600, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {project.name}
      </strong>
      <nav className="tabs" style={{ marginLeft: 6 }}>
        <NavLink className={cls} to={`${base}/moodboard`} end={false}>Moodboard</NavLink>
        <NavLink className={cls} to={`${base}/tasks`}>Tasks</NavLink>
        <NavLink className={cls} to={`${base}/story`}>Story</NavLink>
        <NavLink className={cls} to={`${base}/assets`}>Assets</NavLink>
        <NavLink className={cls} to={`${base}/history`}>History</NavLink>
        <NavLink className={cls} to={`${base}/settings`}>Settings</NavLink>
      </nav>
    </>,
    slot
  );
}

function Settings({ project, onChange }) {
  const [name, setName] = useState(project.name);
  const [summary, setSummary] = useState(project.summary);
  const [picking, setPicking] = useState(false);
  const { user } = useSession();
  const say = useToast();

  async function save() {
    await api.patch(`/api/projects/${project.id}`, { name, summary });
    say('Project saved');
    onChange();
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 620 }}>
        <p className="eyebrow">Project</p>
        <h1 style={{ marginBottom: 22 }}>Settings</h1>
        <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <label>Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>One-line pitch</label>
            <textarea className="input" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="row">
            <button className="btn primary" onClick={save}>Save changes</button>
            <span className="hint mono">{project.id}</span>
          </div>
        </div>

        {user.isAdmin && (
          <div className="card" style={{ padding: 18, marginTop: 16 }}>
            <h3 style={{ marginBottom: 6 }}>Cover image</h3>
            <p className="hint" style={{ margin: '0 0 14px' }}>
              Shown on the project card. Any image already in the project will do, or upload a new one —
              you can also right-click a picture on a moodboard and set it from there.
            </p>
            <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
              <div className="cover-preview">
                {project.cover
                  ? <img src={mediaUrl(project.cover.thumb)} alt="" />
                  : <span className="eyebrow">None set</span>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button className="btn" onClick={() => setPicking(true)}><Icon.Cover /> Choose an image</button>
                {project.cover && (
                  <button className="btn ghost" onClick={async () => {
                    await api.patch(`/api/projects/${project.id}`, { coverImageId: null });
                    say('Cover cleared');
                    onChange();
                  }}>Clear the cover</button>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="card" style={{ padding: 18, marginTop: 16 }}>
          <h3 style={{ marginBottom: 6 }}>Take a copy away with you</h3>
          <p className="hint" style={{ margin: '0 0 14px' }}>
            One zip holding everything in this project — boards, nested boards, cards, story
            threads and every picture. Import it into any Drydock and it arrives as a separate
            project, so it works as a backup, as a way to move to another machine, and as a way
            to hand a whole project to someone else.
          </p>
          <a className="btn" href={`/api/transfer/${project.id}/export`} download>
            <Icon.Download /> Export this project
          </a>
        </div>

        <div className="card" style={{ padding: 18, marginTop: 16 }}>
          <h3 style={{ marginBottom: 6 }}>Deleting this project</h3>
          <p className="hint" style={{ margin: 0 }}>
            A project is the one thing no restore point can bring back, so it cannot be deleted from
            here. If you really want it gone, run this on the machine hosting Drydock — it will ask
            you to type the project name out in full first.
          </p>
          <pre className="mono cmd">docker exec -it drydock node src/cli.js delete-project</pre>
        </div>

        {picking && (
          <CoverPicker
            projectId={project.id}
            onClose={() => setPicking(false)}
            onPicked={() => { setPicking(false); onChange(); }}
          />
        )}
      </div>

    </div>
  );
}

function CoverPicker({ projectId, onClose, onPicked }) {
  const [images, setImages] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const say = useToast();

  const load = useCallback(async () => {
    const r = await api.get(`/api/images/project/${projectId}`);
    setImages(r.images);
  }, [projectId]);

  useEffect(() => { load().catch(() => setImages([])); }, [load]);

  async function upload(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      list.forEach((f) => fd.append('files', f));
      const { images: added } = await api.form(`/api/images/project/${projectId}`, fd);
      if (added[0]) await choose(added[0]);
    } catch (e) { say(e.message); setBusy(false); }
  }

  async function choose(img) {
    setBusy(true);
    try {
      await api.patch(`/api/projects/${projectId}`, { coverImageId: img.id });
      say('Cover updated');
      onPicked();
    } catch (e) { say(e.message); setBusy(false); }
  }

  return (
    <Modal title="Choose a cover" onClose={onClose} wide
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy} onClick={() => fileRef.current.click()}>
          {busy ? <div className="spin" /> : <Icon.Plus />} Upload a new one
        </button>
      </>}>
      {images === null && <div className="spin" />}
      {images?.length === 0 && (
        <p className="hint" style={{ margin: 0 }}>
          Nothing uploaded to this project yet. Upload one below and it becomes the cover.
        </p>
      )}
      {images?.length > 0 && (
        <div className="cover-grid">
          {images.map((img) => (
            <button key={img.id} className="cover-option" onClick={() => choose(img)} title={img.original_name}>
              <img src={mediaUrl(img.thumb)} alt={img.original_name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/*" hidden
        onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
    </Modal>
  );
}
