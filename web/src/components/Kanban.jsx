import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useRoom } from '../lib/realtime.js';
import { Icon, Modal, Peers, useToast } from './ui.jsx';
import { CommitInput, ContextMenu, useContextMenu } from './controls.jsx';
import { memberAccent, memberName, useMembers } from '../lib/members.js';
import { useFocusTarget } from '../lib/focus.js';

const TAG_SET = ['design', 'art', 'code', 'audio', 'narrative', 'bug', 'blocked'];

const today = () => new Date().toISOString().slice(0, 10);
const ticked = (list) => (list || []).filter((t) => t.done).length;
const newItemId = () => `t${Math.random().toString(36).slice(2, 10)}`;

export default function Kanban({ projectId }) {
  const [columns, setColumns] = useState([]);
  const [cards, setCards] = useState([]);
  const [open, setOpen] = useState(null);
  const [over, setOver] = useState(null);
  const dragged = useRef(null);
  const say = useToast();
  const ctx = useContextMenu();
  const [renaming, setRenaming] = useState(null);
  const members = useMembers();

  const load = useCallback(async () => {
    const r = await api.get(`/api/kanban/${projectId}`);
    setColumns(r.columns);
    setCards(r.cards);
  }, [projectId]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  // arriving from a search result: open the card that matched
  useFocusTarget(cards, setOpen, 'card');

  const peers = useRoom(`kanban:${projectId}`, {
    onResync: load,
    onOp: (op) => {
      if (op.kind === 'column.create') setColumns((s) => [...s, op.column].sort((a, b) => a.position - b.position));
      else if (op.kind === 'column.update') setColumns((s) => s.map((c) => (c.id === op.column.id ? op.column : c)).sort((a, b) => a.position - b.position));
      else if (op.kind === 'column.delete') { setColumns((s) => s.filter((c) => c.id !== op.id)); setCards((s) => s.filter((c) => c.column_id !== op.id)); }
      else if (op.kind === 'card.create') setCards((s) => (s.some((c) => c.id === op.card.id) ? s : [...s, op.card]));
      else if (op.kind === 'card.update') setCards((s) => s.map((c) => (c.id === op.card.id ? op.card : c)));
      else if (op.kind === 'card.delete') setCards((s) => s.filter((c) => c.id !== op.id));
    },
  });

  const inColumn = (id) => cards.filter((c) => c.column_id === id).sort((a, b) => a.position - b.position);

  async function addColumn(name = 'New column') {
    const { column } = await api.post(`/api/kanban/${projectId}/columns`, { name });
    setColumns((s) => [...s, column]);
    setRenaming(column);
  }

  function boardMenu(e) {
    ctx.open(e, [
      { label: 'New column', icon: <Icon.Plus />, onClick: () => addColumn() },
    ], { title: 'Board' });
  }

  function columnMenu(e, col) {
    e.stopPropagation();
    ctx.open(e, [
      { label: 'Add a card', icon: <Icon.Plus />, onClick: () => addCard(col.id, 'New card') },
      { label: 'Rename column', icon: <Icon.Text />, onClick: () => setRenaming(col) },
      { divider: true },
      { label: 'New column', icon: <Icon.Board />, onClick: () => addColumn() },
      { divider: true },
      { label: 'Delete column', icon: <Icon.Trash />, danger: true, onClick: () => removeColumn(col) },
    ], { title: col.name });
  }

  function cardMenu(e, card, col) {
    e.stopPropagation();
    ctx.open(e, [
      { label: 'Open card', icon: <Icon.Script />, onClick: () => setOpen(card) },
      {
        label: 'Duplicate', icon: <Icon.Copy />,
        onClick: () => duplicateCard(card, col.id),
      },
      { divider: true },
      ...columns.filter((c) => c.id !== col.id).slice(0, 5).map((c) => ({
        label: `Move to ${c.name}`, icon: <Icon.Back />,
        onClick: () => saveCard(card.id, { columnId: c.id, position: Date.now() }),
      })),
      { divider: true },
      { label: 'Delete card', icon: <Icon.Trash />, danger: true, onClick: () => deleteCard(card.id) },
    ], { title: card.title });
  }

  async function addCard(columnId, title) {
    const { card } = await api.post(`/api/kanban/columns/${columnId}/cards`, { title });
    setCards((s) => [...s, card]);
  }

  /** A copy is only useful if it brings the notes and the checklist with it. */
  async function duplicateCard(card, columnId) {
    const { card: made } = await api.post(`/api/kanban/columns/${columnId}/cards`, {
      title: `${card.title} copy`,
      body: card.body,
      tags: card.tags,
      due: card.due,
      assignee: card.assignee,
      checklist: (card.checklist || []).map((t) => ({ ...t, done: false })),
    });
    setCards((s) => [...s, made]);
  }

  async function saveCard(id, patch) {
    const local = { ...patch };
    if (local.columnId) { local.column_id = local.columnId; delete local.columnId; }
    setCards((s) => s.map((c) => (c.id === id ? { ...c, ...local } : c)));
    const { card } = await api.patch(`/api/kanban/cards/${id}`, patch);
    setCards((s) => s.map((c) => (c.id === id ? card : c)));
  }

  async function deleteCard(id) {
    setCards((s) => s.filter((c) => c.id !== id));
    setOpen(null);
    await api.del(`/api/kanban/cards/${id}`);
  }

  function onDrop(columnId, index) {
    const card = dragged.current;
    setOver(null);
    if (!card) return;
    const list = inColumn(columnId).filter((c) => c.id !== card.id);
    const before = list[index - 1]?.position ?? 0;
    const after = list[index]?.position ?? before + 2000;
    const position = (before + after) / 2;
    saveCard(card.id, { columnId, position });
    dragged.current = null;
  }

  async function renameColumn(col, name) {
    if (!name?.trim() || name === col.name) { setRenaming(null); return; }
    const { column } = await api.patch(`/api/kanban/columns/${col.id}`, { name: name.trim() });
    setColumns((s) => s.map((c) => (c.id === col.id ? column : c)));
    setRenaming(null);
  }

  async function removeColumn(col) {
    const n = inColumn(col.id).length;
    if (!confirm(n ? `Delete “${col.name}” and its ${n} card${n > 1 ? 's' : ''}?` : `Delete “${col.name}”?`)) return;
    await api.del(`/api/kanban/columns/${col.id}`);
    setColumns((s) => s.filter((c) => c.id !== col.id));
    setCards((s) => s.filter((c) => c.column_id !== col.id));
    say('Column deleted');
  }

  return (
    <div className="kan" onContextMenu={boardMenu}>
      {columns.map((col) => {
        const list = inColumn(col.id);
        return (
          <section key={col.id} className={`kan-col${over === col.id ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(col.id); }}
            onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); onDrop(col.id, list.length); }}
            onContextMenu={(e) => columnMenu(e, col)}>
            <header>
              {renaming?.id === col.id
                ? <CommitInput value={col.name} autoFocus style={{ height: 26, padding: '2px 7px', fontSize: 13 }}
                    onCommit={(v) => renameColumn(col, v)} onBlurCapture={() => setRenaming(null)} />
                : <span className="name" onDoubleClick={() => setRenaming(col)} title="Double-click to rename">{col.name}</span>}
              <span className="chip">{list.length}</span>
              <button className="btn ghost icon sm" title="Delete column" onClick={() => removeColumn(col)}><Icon.Trash /></button>
            </header>
            <div className="kan-list">
              {list.map((card, i) => (
                <article
                  key={card.id}
                  className="kan-card"
                  draggable
                  onDragStart={() => { dragged.current = card; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(col.id, i); }}
                  onContextMenu={(e) => cardMenu(e, card, col)}
                  onClick={() => setOpen(card)}
                >
                  <div className="title">{card.title}</div>
                  <CardFace card={card} members={members} />
                </article>
              ))}
              {!list.length && <p className="hint" style={{ margin: '4px 2px' }}>Nothing here yet.</p>}
            </div>
            <QuickAdd onAdd={(t) => addCard(col.id, t)} />
          </section>
        );
      })}

      <button className="btn" style={{ flex: '0 0 auto' }} onClick={() => addColumn()}><Icon.Plus /> Column</button>

      <ContextMenu menu={ctx.menu} onClose={ctx.close} />

      <div style={{ position: 'absolute', right: 16, top: 14 }}><Peers peers={peers} /></div>

      {open && (
        <CardEditor
          card={cards.find((c) => c.id === open.id) || open}
          columns={columns}
          members={members}
          onSave={saveCard}
          onDelete={deleteCard}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function QuickAdd({ onAdd }) {
  const [text, setText] = useState('');
  return (
    <div className="kan-add">
      <input
        className="input" value={text} placeholder="+ Add a card"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) { onAdd(text.trim()); setText(''); }
          if (e.key === 'Escape') setText('');
        }}
      />
    </div>
  );
}

/** The strip under a card title: who has it, when it is due, how far along. */
function CardFace({ card, members }) {
  const list = card.checklist || [];
  const done = ticked(list);
  const overdue = card.due && card.due < today();
  const who = memberName(members, card.assignee);
  const nothing = !card.tags?.length && !card.due && !list.length && !who;
  if (nothing) return null;

  return (
    <div className="tags">
      {card.tags?.map((t) => <span key={t} className="tag">{t}</span>)}
      {card.due && (
        <span className={`tag due${overdue ? ' overdue' : ''}`} title={overdue ? 'Overdue' : 'Due'}>
          {card.due}
        </span>
      )}
      {list.length > 0 && (
        <span className={`tag${done === list.length ? ' complete' : ''}`} title="Checklist">
          {done}/{list.length}
        </span>
      )}
      {who && (
        <span className="peer tiny" style={{ background: memberAccent(members, card.assignee) }} title={who}>
          {who.slice(0, 1).toUpperCase()}
        </span>
      )}
    </div>
  );
}

function CardEditor({ card, columns, members, onSave, onDelete, onClose }) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [tags, setTags] = useState(card.tags || []);
  const [due, setDue] = useState(card.due || '');
  const [assignee, setAssignee] = useState(card.assignee || '');
  const [checklist, setChecklist] = useState(card.checklist || []);
  const [columnId, setColumnId] = useState(card.column_id);

  function save() {
    onSave(card.id, {
      title,
      body,
      tags,
      due: due || null,
      assignee: assignee || null,
      checklist: checklist.filter((t) => t.text.trim()),
      columnId,
    });
    onClose();
  }

  const done = ticked(checklist);

  return (
    <Modal title="Card" onClose={onClose} wide
      footer={<>
        <button className="btn danger" onClick={() => onDelete(card.id)}><Icon.Trash /> Delete</button>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save card</button>
      </>}>
      <div className="field">
        <label>Title</label>
        <input className="input" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Notes</label>
        <textarea className="input" style={{ minHeight: 110 }} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>

      <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Column</label>
          <select className="input" value={columnId} onChange={(e) => setColumnId(e.target.value)}>
            {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Owner</label>
          <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Nobody yet</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Due</label>
          <div className="row">
            <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            {due && <button className="btn ghost icon sm" onClick={() => setDue('')} aria-label="Clear the due date"><Icon.Close /></button>}
          </div>
        </div>
      </div>

      <Checklist items={checklist} onChange={setChecklist} done={done} />

      <div className="field">
        <label>Tags</label>
        <div className="swatches">
          {TAG_SET.map((t) => (
            <button key={t} className={`btn sm${tags.includes(t) ? ' on' : ''}`}
              onClick={() => setTags((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]))}>{t}</button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Ticking a box is the most common thing anyone does on a card, so it is one
 * click and nothing else — no separate edit mode, no save button. Everything
 * commits with the card.
 */
function Checklist({ items, onChange, done }) {
  // which row to put the caret in once React has painted it. Relying on
  // autoFocus alone loses the race when Enter is pressed quickly.
  const focusNext = useRef(null);
  const rows = useRef(new Map());

  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    rows.current.get(id)?.focus();
  }, [items]);

  const add = () => {
    const row = { id: newItemId(), text: '', done: false };
    focusNext.current = row.id;
    onChange([...items, row]);
  };
  const set = (id, patch) => onChange(items.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const drop = (id) => {
    rows.current.delete(id);
    onChange(items.filter((t) => t.id !== id));
  };

  return (
    <div className="field">
      <div className="row between">
        <label>Checklist</label>
        {items.length > 0 && (
          <span className="hint mono">{done} of {items.length}</span>
        )}
      </div>

      {items.length > 0 && (
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
      )}

      <div className="checklist">
        {items.map((item, i) => (
          <div className="check-row" key={item.id}>
            <input
              type="checkbox"
              checked={item.done}
              aria-label={item.text || `Step ${i + 1}`}
              onChange={(e) => set(item.id, { done: e.target.checked })}
            />
            <input
              ref={(el) => { if (el) rows.current.set(item.id, el); else rows.current.delete(item.id); }}
              className={`input${item.done ? ' struck' : ''}`}
              value={item.text}
              placeholder="What needs doing?"
              onChange={(e) => set(item.id, { text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); add(); }
                if (e.key === 'Backspace' && !item.text && items.length > 1) { e.preventDefault(); drop(item.id); }
              }}
            />
            <button className="btn ghost icon sm" onClick={() => drop(item.id)} aria-label="Remove this step">
              <Icon.Close />
            </button>
          </div>
        ))}
      </div>

      <div>
        <button className="btn sm" onClick={add}><Icon.Plus /> Add a step</button>
      </div>
    </div>
  );
}
