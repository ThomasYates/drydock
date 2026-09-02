import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, mediaUrl } from '../lib/api.js';
import { Empty, Icon, Modal, useToast } from './ui.jsx';

export default function Projects() {
  const [projects, setProjects] = useState(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(
    () => api.get('/api/projects').then((r) => setProjects(r.projects)).catch(() => setProjects([])),
    [],
  );

  useEffect(() => { load(); }, [load]);

  return (
    <div className="page">
      <div className="page-inner">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 22 }}>
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>Projects</h1>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => setImporting(true)}><Icon.Up /> Import</button>
          <button className="btn primary" onClick={() => setCreating(true)}><Icon.Plus /> New project</button>
        </div>

        {projects === null && <div className="spin" />}

        {projects?.length === 0 && (
          <Empty
            title="Nothing in the dock yet"
            hint="A project gives you a moodboard, a task board and a story graph in one place. Start with a working title — you can rename it later."
            action={<button className="btn primary" onClick={() => setCreating(true)}><Icon.Plus /> New project</button>}
          />
        )}

        {projects?.length > 0 && (
          <div className="grid">
            {projects.map((p) => (
              <Link key={p.id} to={`/p/${p.id}`} className="card project-card">
                {p.cover_thumb && (
                  <div className="project-cover"><img src={mediaUrl(p.cover_thumb)} alt="" loading="lazy" /></div>
                )}
                <div>
                  <h2 style={{ fontSize: 17 }}>{p.name}</h2>
                  {p.summary && <p className="hint" style={{ margin: '5px 0 0' }}>{p.summary}</p>}
                </div>
                <div className="meta">
                  <div><span className="n mono">{p.image_count}</span><span className="eyebrow">Images</span></div>
                  <div><span className="n mono">{p.board_count}</span><span className="eyebrow">Boards</span></div>
                  <div><span className="n mono">{p.card_count}</span><span className="eyebrow">Cards</span></div>
                  <div><span className="n mono">{p.node_count}</span><span className="eyebrow">Beats</span></div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
      {creating && <NewProject onClose={() => setCreating(false)} />}
      {importing && <ImportProject onClose={() => setImporting(false)} onDone={load} />}
    </div>
  );
}

/**
 * The other half of the export button in a project's settings. It always makes
 * a new project rather than merging into one, so importing the same file twice
 * gives two projects and never a half-overwritten one.
 */
function ImportProject({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const nav = useNavigate();
  const say = useToast();

  async function run() {
    if (!file) { setError('Choose a .drydock.zip file first'); return; }
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('archive', file);
      if (name.trim()) fd.append('name', name.trim());
      const res = await api.form('/api/transfer/import', fd);
      const { boards, cards, nodes, images } = res.counts;
      say(`Imported ${boards} boards, ${cards} cards, ${nodes} beats and ${images} images`);
      await onDone();
      nav(`/p/${res.project.id}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Import a project" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={run} disabled={busy || !file}>
          {busy ? <div className="spin" /> : null} Import
        </button>
      </>}>
      <div className="field">
        <label>Archive</label>
        <div className="row">
          <button className="btn" onClick={() => fileRef.current.click()}>
            <Icon.Up /> Choose a file
          </button>
          <span className="hint mono">{file ? file.name : 'nothing chosen'}</span>
        </div>
        <span className="hint">
          A <span className="mono">.drydock.zip</span> from any Drydock — export one from a
          project&rsquo;s Settings tab.
        </span>
      </div>

      <div className="field">
        <label>Call it</label>
        <input className="input" value={name} placeholder="Leave blank to keep its own name"
          onChange={(e) => setName(e.target.value)} />
      </div>

      <p className="hint" style={{ margin: 0 }}>
        This always creates a new project. Nothing already here is touched.
      </p>

      {error && <div className="error">{error}</div>}

      <input ref={fileRef} type="file" accept=".zip,application/zip" hidden
        onChange={(e) => { setFile(e.target.files[0] || null); setError(''); e.target.value = ''; }} />
    </Modal>
  );
}

function NewProject({ onClose }) {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nav = useNavigate();
  const say = useToast();

  async function create() {
    if (!name.trim()) { setError('Give the project a name'); return; }
    setBusy(true);
    try {
      const { project } = await api.post('/api/projects', { name, summary });
      say('Project created with a moodboard, task board and story thread');
      nav(`/p/${project.id}`);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <Modal title="New project" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={create} disabled={busy}>Create project</button>
      </>}>
      <div className="field">
        <label>Name</label>
        <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()} placeholder="Working title" />
      </div>
      <div className="field">
        <label>One-line pitch</label>
        <textarea className="input" value={summary} onChange={(e) => setSummary(e.target.value)}
          placeholder="What is this game, in a sentence?" />
      </div>
      <p className="hint" style={{ margin: 0 }}>
        You will get a root moodboard, a five-column task board and a story thread with a few starter beats.
      </p>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
