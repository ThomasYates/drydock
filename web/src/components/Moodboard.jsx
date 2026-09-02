import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, mediaUrl } from '../lib/api.js';
import { boundsOf, gridStyle, useViewport } from '../lib/canvas.js';
import { useFocusTarget } from '../lib/focus.js';
import { live, useRoom } from '../lib/realtime.js';
import { Icon, Modal, Peers, useToast } from './ui.jsx';
import { PeerCursors, usePeerCursors } from './Cursors.jsx';
import { CommitInput, ContextMenu, NumberField, useContextMenu } from './controls.jsx';
import { FONTS, DEFAULT_FONT, fontStack } from '../lib/fonts.js';
import { useSession } from '../lib/session.js';

/** Shared between boards for the session, so you can copy across boards. */
let clipboard = [];

const TEXT_COLOURS = ['#dde5ef', '#e2a445', '#59c2d6', '#6fbf8b', '#e0685f', '#9a8cf0', '#7f8fa3'];
const FRAME_COLOURS = ['#2a3644', '#e2a445', '#59c2d6', '#6fbf8b', '#e0685f', '#9a8cf0'];

export default function Moodboard({ projectId, boardId }) {
  const stage = useRef(null);
  const nav = useNavigate();
  const say = useToast();
  const view = useViewport(stage, boardId);
  const { vp, home: goHome } = view;

  const [, setBoard] = useState(null);
  const [trail, setTrail] = useState([]);
  const [items, setItems] = useState([]);
  const [images, setImages] = useState({});
  const [children, setChildren] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [ghosts, setGhosts] = useState({});
  const [urlModal, setUrlModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const dropPoint = useRef(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const room = boardId ? `board:${boardId}` : null;
  const cursor = usePeerCursors(room, view.toWorld);
  const holding = useRef(0);
  const ctx = useContextMenu();
  const pointerAt = useRef({ x: 0, y: 0 });
  const { user } = useSession();

  const load = useCallback(async () => {
    if (!boardId) return;
    const r = await api.get(`/api/boards/${boardId}`);
    setBoard(r.board);
    setTrail(r.trail);
    setItems(r.items);
    setChildren(r.children);
    setImages(Object.fromEntries(r.images.map((i) => [i.id, i])));
  }, [boardId]);

  useEffect(() => { setSel(new Set()); setEditing(null); load().catch(() => {}); }, [load]);

  // arriving from a search result: frame the item and select it
  useFocusTarget(items, (item) => {
    view.fit({ x: item.x, y: item.y, w: item.w, h: item.h }, 240);
    setSel(new Set([item.id]));
  });

  /* ── realtime ─────────────────────────────────────────── */
  const peers = useRoom(room, {
    onResync: load,
    onLive: (msg) => {
      cursor.receive(msg);
      if (msg.data?.kind === 'move') {
        setGhosts((g) => {
          const next = { ...g };
          for (const m of msg.data.moves) next[m.id] = { x: m.x, y: m.y, by: msg.user.name, accent: msg.user.accent };
          return next;
        });
      } else if (msg.data?.kind === 'moveEnd') {
        setGhosts((g) => {
          const next = { ...g };
          for (const id of msg.data.ids) delete next[id];
          return next;
        });
      }
    },
    onOp: (op) => {
      if (op.kind === 'item.create') {
        setItems((s) => [...s, ...op.items.filter((n) => !s.some((o) => o.id === n.id))]);
        const missing = op.items.filter((i) => i.type === 'image' && i.data.imageId && !images[i.data.imageId]);
        if (missing.length) api.get(`/api/images/project/${projectId}`).then((r) => setImages(Object.fromEntries(r.images.map((i) => [i.id, i]))));
      } else if (op.kind === 'item.patch') {
        setItems((s) => s.map((it) => {
          const p = op.patches.find((x) => x.id === it.id);
          return p ? { ...it, ...p.patch } : it;
        }));
        setGhosts((g) => {
          const next = { ...g };
          for (const p of op.patches) delete next[p.id];
          return next;
        });
      } else if (op.kind === 'item.update') {
        setItems((s) => s.map((it) => (it.id === op.id ? { ...it, ...op.patch } : it)));
      } else if (op.kind === 'item.delete') {
        setItems((s) => s.filter((it) => !op.ids.includes(it.id)));
      } else if (op.kind === 'board.rename') {
        setBoard((b) => (b ? { ...b, name: op.name } : b));
        setTrail((t) => t.map((x) => (x.id === op.id ? { ...x, name: op.name } : x)));
      }
    },
  });

  useEffect(() => {
    const here = new Set(peers.map((p) => p.clientId));
    for (const id of Object.keys(cursor.cursors)) if (!here.has(id)) cursor.forget(id);
  }, [peers, cursor]);

  /* ── persistence helpers ──────────────────────────────── */
  const patchItems = useCallback(async (patches) => {
    if (!patches.length) return;
    setItems((s) => s.map((it) => {
      const p = patches.find((x) => x.id === it.id);
      if (!p) return it;
      return { ...it, ...p, data: p.data ? { ...it.data, ...p.data } : it.data };
    }));
    await api.patch(`/api/boards/${boardId}/items`, { patches }).catch(() => say('Could not save that change'));
  }, [boardId, say]);

  const addItems = useCallback(async (list) => {
    const r = await api.post(`/api/boards/${boardId}/items`, { items: list });
    setItems((s) => [...s, ...r.items]);
    setSel(new Set(r.items.map((i) => i.id)));
    if (r.items.some((i) => i.type === 'board')) load();
    return r.items;
  }, [boardId, load]);

  const removeSelected = useCallback(async () => {
    const ids = [...sel];
    if (!ids.length) return;
    const boards = items.filter((i) => ids.includes(i.id) && i.type === 'board');
    if (boards.length && !confirm(`Delete ${boards.length} nested board${boards.length > 1 ? 's' : ''} and everything inside?`)) return;
    setItems((s) => s.filter((i) => !ids.includes(i.id)));
    setSel(new Set());
    await api.post(`/api/boards/${boardId}/items/delete`, { ids }).catch(() => say('Could not delete'));
  }, [sel, items, boardId, say]);

  const copySelection = useCallback(() => {
    const picked = itemsRef.current.filter((i) => sel.has(i.id) && i.type !== 'board');
    if (!picked.length) return false;
    clipboard = picked.map((i) => ({ type: i.type, x: i.x, y: i.y, w: i.w, h: i.h, data: i.data }));
    say(`Copied ${picked.length} item${picked.length > 1 ? 's' : ''}`);
    return true;
  }, [sel, say]);

  const pasteClipboard = useCallback(async () => {
    if (!clipboard.length) return;
    const at = view.toWorld(pointerAt.current.x, pointerAt.current.y);
    const originX = Math.min(...clipboard.map((i) => i.x));
    const originY = Math.min(...clipboard.map((i) => i.y));
    await addItems(clipboard.map((i) => ({
      ...i,
      x: Math.round(at.x + (i.x - originX)),
      y: Math.round(at.y + (i.y - originY)),
    })));
    say(`Pasted ${clipboard.length} item${clipboard.length > 1 ? 's' : ''}`);
  }, [view, addItems, say]);

  /* ── viewport-centred placement ───────────────────────── */
  const centre = useCallback(() => {
    const r = stage.current.getBoundingClientRect();
    return { x: (r.width / 2 - vp.x) / vp.k, y: (r.height / 2 - vp.y) / vp.k };
  }, [vp]);

  /* ── uploads ──────────────────────────────────────────── */
  const uploadFiles = useCallback(async (files, at) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      list.forEach((f) => fd.append('files', f));
      const { images: uploaded } = await api.form(`/api/images/project/${projectId}`, fd);
      setImages((m) => ({ ...m, ...Object.fromEntries(uploaded.map((i) => [i.id, i])) }));
      const origin = at || dropPoint.current || centre();
      dropPoint.current = null;
      let cursor = 0;
      const news = uploaded.map((img) => {
        const w = Math.min(420, img.width || 420);
        const h = Math.round(w * ((img.height || 300) / (img.width || 420)));
        const it = { type: 'image', x: origin.x + cursor, y: origin.y, w, h, data: { imageId: img.id, quality: 'auto', radius: 2, opacity: 1 } };
        cursor += w + 18;
        return it;
      });
      await addItems(news);
      say(`${uploaded.length} image${uploaded.length > 1 ? 's' : ''} added`);
    } catch (e) {
      say(e.message);
    } finally { setBusy(false); }
  }, [projectId, centre, addItems, say]);

  /* paste + drop */
  useEffect(() => {
    const onPaste = async (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target?.tagName) || e.target?.isContentEditable) return;
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); uploadFiles(files); return; }
      const text = e.clipboardData?.getData('text')?.trim();
      if (!text) return;
      e.preventDefault();
      if (/^https?:\/\/\S+$/i.test(text)) {
        setBusy(true);
        try {
          const { image } = await api.post(`/api/images/project/${projectId}/from-url`, { url: text });
          setImages((m) => ({ ...m, [image.id]: image }));
          const c = centre();
          const w = Math.min(420, image.width || 420);
          await addItems([{ type: 'image', x: c.x, y: c.y, w, h: Math.round(w * (image.height / image.width)), data: { imageId: image.id, quality: 'auto', radius: 2, opacity: 1 } }]);
          say('Image pulled in');
        } catch { say('That link is not an image — dropped it in as text'); const c = centre(); addItems([{ type: 'text', x: c.x, y: c.y, w: 320, h: 90, data: { text, size: 16, colour: '#dde5ef', align: 'left', bg: 'none' } }]); }
        finally { setBusy(false); }
      } else {
        const c = centre();
        addItems([{ type: 'text', x: c.x, y: c.y, w: 340, h: Math.max(80, 26 + text.split('\n').length * 22), data: { text, size: 16, colour: '#dde5ef', align: 'left', bg: 'panel' } }]);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadFiles, projectId, centre, addItems, say]);

  /* keyboard */
  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target?.tagName) || e.target?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
      else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(new Set(itemsRef.current.map((i) => i.id))); }
      else if (mod && e.key.toLowerCase() === 'c') { if (copySelection()) e.preventDefault(); }
      else if (mod && e.key.toLowerCase() === 'x') { if (copySelection()) { e.preventDefault(); removeSelected(); } }
      else if (mod && e.key.toLowerCase() === 'v') {
        if (clipboard.length) { e.preventDefault(); pasteClipboard(); }
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const copies = itemsRef.current.filter((i) => sel.has(i.id) && i.type !== 'board')
          .map((i) => ({ type: i.type, x: i.x + 28, y: i.y + 28, w: i.w, h: i.h, data: i.data }));
        if (copies.length) addItems(copies);
      } else if (e.key === 'Enter' && sel.size === 1) {
        const only = itemsRef.current.find((i) => i.id === [...sel][0]);
        if (only && (only.type === 'text' || only.type === 'frame')) { e.preventDefault(); setEditing(only.id); }
      } else if (e.key === 'Home') { e.preventDefault(); goHome(); }
      else if (e.key === 'Escape') { setSel(new Set()); setEditing(null); }
      else if (e.key === ']' || e.key === '[') {
        const maxZ = Math.max(0, ...itemsRef.current.map((i) => i.z));
        const minZ = Math.min(0, ...itemsRef.current.map((i) => i.z));
        patchItems([...sel].map((id, i) => ({ id, z: e.key === ']' ? maxZ + 1 + i : minZ - 1 - i })));
      } else if (e.key.startsWith('Arrow') && sel.size) {
        e.preventDefault();
        const step = e.shiftKey ? 20 : 2;
        const dx = (e.key === 'ArrowRight' ? step : 0) - (e.key === 'ArrowLeft' ? step : 0);
        const dy = (e.key === 'ArrowDown' ? step : 0) - (e.key === 'ArrowUp' ? step : 0);
        patchItems(itemsRef.current.filter((i) => sel.has(i.id)).map((i) => ({ id: i.id, x: i.x + dx, y: i.y + dy })));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, removeSelected, addItems, patchItems, copySelection, pasteClipboard, goHome]);

  /* ── pointer interaction ──────────────────────────────── */
  const onStagePointerDown = (e) => {
    if (view.maybePan(e)) return;
    if (e.button !== 0) return;
    // the editor closes itself on blur, which keeps what was typed
    const start = view.toWorld(e.clientX, e.clientY);
    const additive = e.shiftKey;
    if (!additive) setSel(new Set());
    const move = (ev) => {
      const now = view.toWorld(ev.clientX, ev.clientY);
      setMarquee({ x: Math.min(start.x, now.x), y: Math.min(start.y, now.y), w: Math.abs(now.x - start.x), h: Math.abs(now.y - start.y) });
    };
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      const now = view.toWorld(ev.clientX, ev.clientY);
      const box = { x: Math.min(start.x, now.x), y: Math.min(start.y, now.y), w: Math.abs(now.x - start.x), h: Math.abs(now.y - start.y) };
      setMarquee(null);
      if (box.w < 4 && box.h < 4) return;
      const hit = itemsRef.current.filter((i) => i.x < box.x + box.w && i.x + i.w > box.x && i.y < box.y + box.h && i.y + i.h > box.y);
      setSel((s) => new Set(additive ? [...s, ...hit.map((i) => i.id)] : hit.map((i) => i.id)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const startDrag = (e, item) => {
    if (view.maybePan(e)) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    let chosen = sel;
    if (e.shiftKey) {
      chosen = new Set(sel);
      if (chosen.has(item.id)) chosen.delete(item.id); else chosen.add(item.id);
      setSel(chosen);
      return;
    }
    const wasOnlySelection = sel.size === 1 && sel.has(item.id);
    if (!sel.has(item.id)) { chosen = new Set([item.id]); setSel(chosen); }

    const start = view.toWorld(e.clientX, e.clientY);
    const snapshot = itemsRef.current.filter((i) => chosen.has(i.id)).map((i) => ({ id: i.id, x: i.x, y: i.y }));
    let last = 0;
    let moved = false;
    holding.current = snapshot.length;

    const move = (ev) => {
      const now = view.toWorld(ev.clientX, ev.clientY);
      const dx = now.x - start.x;
      const dy = now.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      const moves = snapshot.map((s) => ({ id: s.id, x: Math.round(s.x + dx), y: Math.round(s.y + dy) }));
      setItems((list) => list.map((it) => {
        const m = moves.find((x) => x.id === it.id);
        return m ? { ...it, x: m.x, y: m.y } : it;
      }));
      if (Date.now() - last > 45) { last = Date.now(); live(room, { kind: 'move', moves }); }
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      holding.current = 0;
      live(room, { kind: 'moveEnd', ids: snapshot.map((s) => s.id) });
      if (!moved) {
        // a click on a note that was already the only thing selected opens it
        if (wasOnlySelection && (item.type === 'text' || item.type === 'frame')) setEditing(item.id);
        return;
      }
      const final = itemsRef.current.filter((i) => chosen.has(i.id)).map((i) => ({ id: i.id, x: i.x, y: i.y }));
      patchItems(final);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const startResize = (e, item) => {
    e.stopPropagation();
    e.preventDefault();
    const start = view.toWorld(e.clientX, e.clientY);
    const s0 = { w: item.w, h: item.h };
    const aspect = item.w / item.h;
    const keepAspect = item.type === 'image';
    const move = (ev) => {
      const now = view.toWorld(ev.clientX, ev.clientY);
      const w = Math.max(32, Math.round(s0.w + (now.x - start.x)));
      let h = Math.max(28, Math.round(s0.h + (now.y - start.y)));
      if (keepAspect && !ev.altKey) h = Math.round(w / aspect);
      setItems((list) => list.map((it) => (it.id === item.id ? { ...it, w, h } : it)));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      const now = itemsRef.current.find((i) => i.id === item.id);
      if (now) patchItems([{ id: now.id, w: now.w, h: now.h }]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const openItem = (item) => {
    if (item.type === 'board') nav(`/p/${projectId}/moodboard/${item.data.boardId}`);
    else if (item.type === 'text' || item.type === 'frame') setEditing(item.id);
  };

  const fitAll = () => view.fit(boundsOf(items, (i) => i) || { x: -200, y: -150, w: 400, h: 300 });

  const saveImageToDisk = useCallback((image) => {
    if (!image) return;
    const a = document.createElement('a');
    a.href = mediaUrl(image.file);
    a.download = image.original_name?.replace(/\.[^.]+$/, '') + '.webp';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const setAsProjectCover = useCallback(async (imageId) => {
    try {
      await api.patch(`/api/projects/${projectId}`, { coverImageId: imageId });
      say('Set as the project cover');
    } catch (err) { say(err.message); }
  }, [projectId, say]);

  const canvasMenu = (e) => {
    if (view.recentlyPanned()) { e.preventDefault(); return; }
    pointerAt.current = { x: e.clientX, y: e.clientY };
    const at = view.toWorld(e.clientX, e.clientY);
    ctx.open(e, [
      {
        label: 'Add a note', icon: <Icon.Text />, hint: 'N',
        onClick: () => addItems([{ type: 'text', x: at.x, y: at.y, w: 300, h: 90, data: { text: 'New note', size: 18, colour: '#dde5ef', align: 'left', bg: 'panel' } }])
          .then((r) => setEditing(r[0].id)),
      },
      { label: 'Upload images here', icon: <Icon.Image />, onClick: () => { dropPoint.current = at; fileRef.current.click(); } },
      { label: 'Add image from a link', icon: <Icon.Link />, onClick: () => { dropPoint.current = at; setUrlModal(true); } },
      {
        label: 'Add a board inside', icon: <Icon.Board />,
        onClick: () => addItems([{ type: 'board', x: at.x, y: at.y, w: 260, h: 180, data: { name: 'Untitled board' } }]),
      },
      {
        label: 'Add a frame', icon: <Icon.Frame />,
        onClick: () => addItems([{ type: 'frame', x: at.x - 260, y: at.y - 180, w: 520, h: 360, data: { label: 'Section', colour: '#2a3644' } }]),
      },
      { divider: true },
      clipboard.length > 0 && {
        label: `Paste ${clipboard.length} item${clipboard.length > 1 ? 's' : ''}`,
        icon: <Icon.Copy />, hint: '⌘V', onClick: pasteClipboard,
      },
      { label: 'Select everything', icon: <Icon.Frame />, hint: '⌘A', onClick: () => setSel(new Set(items.map((i) => i.id))) },
      { label: 'Fit to screen', icon: <Icon.Fit />, onClick: fitAll },
    ], { title: 'Add here' });
  };

  const itemMenu = (e, item) => {
    e.stopPropagation();
    pointerAt.current = { x: e.clientX, y: e.clientY };
    if (!sel.has(item.id)) setSel(new Set([item.id]));
    const many = sel.size > 1 && sel.has(item.id);
    const image = item.type === 'image' ? images[item.data.imageId] : null;
    ctx.open(e, [
      item.type === 'board' && { label: 'Open this board', icon: <Icon.Board />, onClick: () => nav(`/p/${projectId}/moodboard/${item.data.boardId}`) },
      (item.type === 'text' || item.type === 'frame') && { label: 'Edit text', icon: <Icon.Text />, hint: 'Enter', onClick: () => setEditing(item.id) },
      item.type === 'text' && {
        label: 'Copy the words', icon: <Icon.Copy />,
        onClick: () => { navigator.clipboard?.writeText(item.data.text || ''); say('Text copied'); },
      },
      image && { label: 'Download image', icon: <Icon.Download />, onClick: () => saveImageToDisk(image) },
      image && { label: 'Open full size', icon: <Icon.Image />, onClick: () => window.open(mediaUrl(image.file), '_blank', 'noopener') },
      image && user.isAdmin && { label: 'Use as project cover', icon: <Icon.Cover />, onClick: () => setAsProjectCover(image.id) },
      image && { divider: true },
      item.type !== 'board' && {
        label: many ? `Copy ${sel.size} items` : 'Copy', icon: <Icon.Copy />, hint: '⌘C', onClick: copySelection,
      },
      clipboard.length > 0 && { label: 'Paste', icon: <Icon.Copy />, hint: '⌘V', onClick: pasteClipboard },
      item.type !== 'board' && {
        label: many ? `Duplicate ${sel.size} items` : 'Duplicate', icon: <Icon.Copy />, hint: '⌘D',
        onClick: () => addItems(items.filter((i) => sel.has(i.id) && i.type !== 'board')
          .map((i) => ({ type: i.type, x: i.x + 28, y: i.y + 28, w: i.w, h: i.h, data: i.data }))),
      },
      { divider: true },
      { label: 'Bring to front', icon: <Icon.Up />, hint: ']', onClick: () => bringTo('front') },
      { label: 'Send to back', icon: <Icon.Down />, hint: '[', onClick: () => bringTo('back') },
      { divider: true },
      { label: many ? `Delete ${sel.size} items` : 'Delete', icon: <Icon.Trash />, danger: true, hint: 'Del', onClick: removeSelected },
    ], { title: many ? `${sel.size} items` : item.type });
  };

  const bringTo = (dir) => {
    const chosen = items.filter((i) => sel.has(i.id));
    const zs = items.map((i) => i.z);
    const base = dir === 'front' ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - chosen.length;
    patchItems(chosen.map((i, idx) => ({ id: i.id, z: base + idx })));
  };

  const selected = useMemo(() => items.filter((i) => sel.has(i.id)), [items, sel]);
  const ordered = useMemo(() => [...items].sort((a, b) => a.z - b.z), [items]);
  const childPeek = useMemo(() => Object.fromEntries(children.map((c) => [c.id, c.thumbs || []])), [children]);

  return (
    <>
      <div
        ref={stage}
        className={`stage${view.panning ? ' grabbing' : ''}`}
        onPointerDown={onStagePointerDown}
        onPointerMove={(e) => {
          pointerAt.current = { x: e.clientX, y: e.clientY };
          cursor.onPointerMove(e, holding.current);
        }}
        onPointerLeave={cursor.onPointerLeave}
        onContextMenu={canvasMenu}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDrop={(e) => { e.preventDefault(); uploadFiles(e.dataTransfer.files, view.toWorld(e.clientX, e.clientY)); }}
      >
        <div className="stage-grid" style={gridStyle(vp)} />

        <div
          className="world"
          style={{
            transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.k})`,
            '--hair': `${1 / vp.k}px`,
            '--hs': `${10 / vp.k}px`,
          }}
        >
          {ordered.map((item) => (
            <BoardItem
              key={item.id}
              item={item}
              ghost={ghosts[item.id]}
              image={item.data.imageId ? images[item.data.imageId] : null}
              peek={item.type === 'board' ? childPeek[item.data.boardId] : null}
              selected={sel.has(item.id)}
              editing={editing === item.id}
              k={vp.k}
              onPointerDown={(e) => startDrag(e, item)}
              onContextMenu={(e) => itemMenu(e, item)}
              onDoubleClick={() => openItem(item)}
              onResize={(e) => startResize(e, item)}
              onSave={(patch) => patchItems([{ id: item.id, ...patch }])}
              onDone={() => setEditing(null)}
            />
          ))}

          {marquee && (
            <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: `${1 / vp.k}px` }} />
          )}
        </div>

        <PeerCursors cursors={cursor.cursors} vp={vp} />

        {/* toolbar */}
        <div className="toolbar">
          <div className="toolgroup">
            <div className="crumbs">
              {trail.map((t, i) => (
                <span key={t.id} style={{ display: 'contents' }}>
                  {i > 0 && <span className="sep">›</span>}
                  {i === trail.length - 1
                    ? <span className="now">{t.name}</span>
                    : <button onClick={() => nav(`/p/${projectId}/moodboard/${t.id}`)}>{t.name}</button>}
                </span>
              ))}
            </div>
          </div>

          <div className="toolgroup">
            <button className="btn sm" onClick={() => fileRef.current.click()} title="Upload images"><Icon.Image /> Images</button>
            <button className="btn sm" onClick={() => setUrlModal(true)} title="Add image from a web address"><Icon.Link /></button>
            <button className="btn sm" title="Add a text note" onClick={() => {
              const c = centre();
              addItems([{ type: 'text', x: c.x - 150, y: c.y - 40, w: 300, h: 90, data: { text: 'New note', size: 18, colour: '#dde5ef', align: 'left', bg: 'panel' } }]).then((r) => setEditing(r[0].id));
            }}><Icon.Text /></button>
            <button className="btn sm" title="Add a board inside this one" onClick={() => {
              const c = centre();
              addItems([{ type: 'board', x: c.x - 130, y: c.y - 90, w: 260, h: 180, data: { name: 'Untitled board' } }]);
            }}><Icon.Board /></button>
            <button className="btn sm" title="Add a grouping frame" onClick={() => {
              const c = centre();
              addItems([{ type: 'frame', x: c.x - 260, y: c.y - 180, w: 520, h: 360, data: { label: 'Section', colour: '#2a3644' } }]);
            }}><Icon.Frame /></button>
          </div>

          <div className="toolgroup">
            <button className="btn sm" onClick={view.home}
              title="Back to the middle of the board, at 100% (Home)">
              <Icon.Target /> Recentre
            </button>
          </div>

          {busy && <div className="toolgroup" style={{ padding: 8 }}><div className="spin" /></div>}
          <Peers peers={peers} />
        </div>

        {/* HUD */}
        <div className="hud">
          <div className="read">
            <span>{Math.round(vp.k * 100)}%</span>
            <span style={{ color: 'var(--dim)' }}>{items.length} item{items.length === 1 ? '' : 's'}</span>
            {sel.size > 0 && <span style={{ color: 'var(--brass)' }}>{sel.size} selected</span>}
          </div>
          <button onClick={() => view.zoomToCentre(1 / 1.25)} title="Zoom out">−</button>
          <button onClick={() => view.resetZoom()} title="Zoom to 100%">1:1</button>
          <button onClick={() => view.zoomToCentre(1.25)} title="Zoom in">+</button>
          <button onClick={fitAll} title="Fit everything on screen"><Icon.Fit /></button>
          <button className={view.wheelZoom ? '' : 'on'} onClick={view.toggleWheel}
            title={view.wheelZoom ? 'Wheel zooms — click to make it pan' : 'Wheel pans — click to make it zoom'}>
            {view.wheelZoom ? '⌖' : '✥'}
          </button>
        </div>

        <input ref={fileRef} type="file" accept="image/*" multiple hidden
          onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
      </div>

      {selected.length > 0 && (
        <Inspector
          items={selected}
          image={selected.length === 1 && selected[0].data.imageId ? images[selected[0].data.imageId] : null}
          onPatch={(patch) => patchItems(selected.map((i) => ({ id: i.id, ...patch })))}
          onDelete={removeSelected}
          onZ={(dir) => {
            const zs = items.map((i) => i.z);
            const base = dir === 'front' ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - selected.length;
            patchItems(selected.map((i, idx) => ({ id: i.id, z: base + idx })));
          }}
          onEdit={(id) => setEditing(id)}
          onEnter={() => selected[0].type === 'board' && nav(`/p/${projectId}/moodboard/${selected[0].data.boardId}`)}
          onRenameBoard={async (name) => {
            await api.patch(`/api/boards/${selected[0].data.boardId}`, { name });
            patchItems([{ id: selected[0].id, data: { name } }]);
            load();
          }}
        />
      )}

      <ContextMenu menu={ctx.menu} onClose={ctx.close} />

      {urlModal && (
        <UrlImport projectId={projectId} onClose={() => setUrlModal(false)} onAdded={(image) => {
          setImages((m) => ({ ...m, [image.id]: image }));
          const c = centre();
          const w = Math.min(420, image.width || 420);
          addItems([{ type: 'image', x: c.x - w / 2, y: c.y - 120, w, h: Math.round(w * (image.height / image.width)), data: { imageId: image.id, quality: 'auto', radius: 2, opacity: 1 } }]);
          setUrlModal(false);
        }} />
      )}
    </>
  );
}

/* ── one item on the board ──────────────────────────────── */
function BoardItem({ item, image, peek, selected, editing, k, ghost, onPointerDown, onContextMenu, onDoubleClick, onResize, onSave, onDone }) {
  const pos = ghost || item;
  const style = {
    left: 0, top: 0, width: item.w, height: item.h,
    transform: `translate(${pos.x}px, ${pos.y}px)${item.rot ? ` rotate(${item.rot}deg)` : ''}`,
    zIndex: item.z,
  };

  return (
    <div className={`item${selected ? ' sel' : ''}`} style={style}
      onPointerDown={onPointerDown} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick}>
      {ghost && (
        <div className="ghost-label" style={{ background: ghost.accent || '#e2a445', fontSize: 10 / k, padding: `${1 / k}px ${5 / k}px` }}>
          {ghost.by}
        </div>
      )}

      {item.type === 'image' && (
        image
          ? <img alt={item.data.caption || image.original_name}
              src={mediaUrl(pickSrc(image, item, k))}
              style={{ borderRadius: item.data.radius ?? 2, opacity: item.data.opacity ?? 1 }}
              draggable={false} loading="lazy" />
          : <div className="item-board empty">image missing</div>
      )}
      {item.type === 'image' && item.data.caption && <div className="caption" style={{ fontSize: 12 }}>{item.data.caption}</div>}

      {item.type === 'text' && (
        editing
          ? <NoteEditor item={item} k={k} onSave={onSave} onDone={onDone} />
          : <div className="item-text" style={{
              fontFamily: fontStack(item.data.font || DEFAULT_FONT),
              fontSize: item.data.size || 16, color: item.data.colour || '#dde5ef',
              textAlign: item.data.align || 'left',
              background: item.data.bg === 'panel' ? 'var(--panel)' : item.data.bg === 'brass' ? 'rgba(226,164,69,.14)' : 'transparent',
              border: item.data.bg === 'none' ? 'none' : `${1 / k}px solid var(--line)`,
              borderRadius: 4,
            }}>{item.data.text || 'Empty note'}</div>
      )}

      {item.type === 'board' && (
        <div className="item-board">
          <div className="head"><Icon.Board /> <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.data.name}</span></div>
          {peek?.length
            ? <div className="peek">{peek.slice(0, 4).map((t) => <img key={t} src={mediaUrl(t)} alt="" draggable={false} />)}</div>
            : <div className="empty">double-click to open</div>}
        </div>
      )}

      {item.type === 'frame' && (
        <div className="item-frame" style={{ borderColor: item.data.colour || '#2a3644' }}>
          {editing
            ? <LabelEditor item={item} onSave={onSave} onDone={onDone} />
            : <span className="label" style={{ fontSize: 12 / k, color: item.data.colour === '#2a3644' ? 'var(--muted)' : item.data.colour }}>{item.data.label}</span>}
        </div>
      )}

      <div className="frame-el" style={ghost ? { boxShadow: `0 0 0 ${2 / k}px ${ghost.accent || '#e2a445'}` } : undefined} />
      {selected && <div className="handle" onPointerDown={onResize} />}
    </div>
  );
}

export function LabelEditor({ item, onSave, onDone, onCommit }) {
  const save = onSave || onCommit;
  const ref = useRef(null);
  const saved = useRef(item.data.label ?? '');
  const timer = useRef(null);
  const push = useRef(() => {});
  push.current = (el) => {
    clearTimeout(timer.current);
    if (!el || el.value === saved.current) return;
    saved.current = el.value;
    save({ data: { label: el.value } });
  };

  useEffect(() => {
    const el = ref.current;
    if (el) { el.focus(); el.select(); }
    return () => { clearTimeout(timer.current); push.current(el); };
  }, []);

  return (
    <input
      ref={ref}
      defaultValue={item.data.label}
      className="label"
      style={{ background: 'var(--panel)', border: '1px solid var(--brass)', color: 'var(--text)', fontSize: 11, padding: '2px 5px', borderRadius: 3, userSelect: 'text' }}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const el = e.target;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => push.current(el), 400);
      }}
      onBlur={(e) => { push.current(e.target); onDone?.(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') { push.current(e.target); e.target.blur(); }
      }}
    />
  );
}

/**
 * A note being edited.
 *
 * Saves after a pause in typing, on Enter, on leaving it, and if the editor is
 * pulled out from under it. The textarea element is captured on mount because
 * React clears the ref before cleanup runs, and a removed element never fires
 * blur — between them that was losing whole notes.
 */
export function NoteEditor({ item, k, onSave, onDone, onCommit }) {
  const save = onSave || onCommit;
  const ref = useRef(null);
  const saved = useRef(item.data.text ?? '');
  const timer = useRef(null);
  const latest = useRef(item);
  latest.current = item;

  const push = useRef(() => {});
  push.current = (el) => {
    clearTimeout(timer.current);
    if (!el || el.value === saved.current) return;
    saved.current = el.value;
    const needed = Math.ceil(el.scrollHeight) + 6;
    const grow = needed > (latest.current.h || 0) ? { h: needed } : {};
    save({ data: { text: el.value }, ...grow });
  };

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return () => { clearTimeout(timer.current); push.current(el); };
  }, []);

  return (
    <textarea
      ref={ref}
      className="item-text"
      defaultValue={item.data.text}
      spellCheck
      style={{
        background: 'var(--panel)',
        border: `${2 / k}px solid var(--brass)`,
        borderRadius: 4,
        fontFamily: fontStack(item.data.font || DEFAULT_FONT),
        fontSize: item.data.size || 16,
        color: item.data.colour || '#dde5ef',
        textAlign: item.data.align || 'left',
        resize: 'none',
        outline: 'none',
        userSelect: 'text',
        cursor: 'text',
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const el = e.target;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => push.current(el), 400);
      }}
      onBlur={(e) => { push.current(e.target); onDone?.(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Enter finishes the note; Shift+Enter starts a new line
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          push.current(e.target);
          onDone?.();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          push.current(e.target);
          onDone?.();
        }
      }}
    />
  );
}

function pickSrc(image, item, k) {
  const shown = item.w * k;
  const q = item.data.quality || 'auto';
  if (q === 'high') return image.file;
  if (q === 'low') return image.thumb;
  return shown < 420 ? image.thumb : image.file;
}

/* ── inspector ───────────────────────────────────────────── */
function Inspector({ items, image, onPatch, onDelete, onZ, onEnter, onEdit, onRenameBoard }) {
  const one = items.length === 1 ? items[0] : null;
  const kind = new Set(items.map((i) => i.type)).size === 1 ? items[0].type : 'mixed';

  return (
    <aside className="inspector">
      <div className="sec">
        <div className="row between">
          <span className="eyebrow">{items.length === 1 ? kind : `${items.length} items`}</span>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn ghost icon sm" title="Bring to front" onClick={() => onZ('front')}><Icon.Up /></button>
            <button className="btn ghost icon sm" title="Send to back" onClick={() => onZ('back')}><Icon.Down /></button>
            <button className="btn ghost icon sm" title="Delete" onClick={onDelete}><Icon.Trash /></button>
          </div>
        </div>
        {one && (
          <>
            <div className="row" style={{ gap: 7 }}>
              <NumberField label="X" value={Math.round(one.x)} onChange={(v) => onPatch({ x: v })} />
              <NumberField label="Y" value={Math.round(one.y)} onChange={(v) => onPatch({ y: v })} />
            </div>
            <div className="row" style={{ gap: 7 }}>
              <NumberField label="W" min={32} value={Math.round(one.w)} onChange={(v) => onPatch({ w: v })} />
              <NumberField label="H" min={28} value={Math.round(one.h)} onChange={(v) => onPatch({ h: v })} />
            </div>
          </>
        )}
      </div>

      {kind === 'image' && (
        <div className="sec">
          <span className="eyebrow">Display quality</span>
          <div className="seg">
            {['auto', 'low', 'high'].map((q) => (
              <button key={q} className={(one?.data.quality || 'auto') === q ? 'on' : ''} onClick={() => onPatch({ data: { quality: q } })}>
                {q === 'auto' ? 'Auto' : q === 'low' ? 'Proxy' : 'Full'}
              </button>
            ))}
          </div>
          <p className="hint" style={{ margin: 0 }}>
            Auto swaps to the small proxy when the image is small on screen. Force Full if you are eyeballing detail.
          </p>
          <Slider label="Opacity" min={10} max={100} value={Math.round((one?.data.opacity ?? 1) * 100)} onChange={(v) => onPatch({ data: { opacity: v / 100 } })} />
          <Slider label="Corner radius" min={0} max={40} value={one?.data.radius ?? 2} onChange={(v) => onPatch({ data: { radius: v } })} />
          {one && (
            <div className="field">
              <label>Caption</label>
              <CommitInput key={`${one.id}-cap`} value={one.data.caption || ''} allowEmpty placeholder="Optional"
                onCommit={(v) => onPatch({ data: { caption: v } })} />
            </div>
          )}
          {image && (
            <div className="row between">
              <span className="hint mono">{image.width}×{image.height}</span>
              <a className="btn ghost sm" href={mediaUrl(image.file)} target="_blank" rel="noreferrer">Open original</a>
            </div>
          )}
        </div>
      )}

      {kind === 'text' && (
        <div className="sec">
          <span className="eyebrow">Text</span>
          {one && <button className="btn" onClick={() => onEdit(one.id)}><Icon.Text /> Edit this note</button>}
          <p className="hint" style={{ margin: 0 }}>Or double-click the note on the board, or press Enter with it selected.</p>
          <div className="field">
            <label>Typeface</label>
            <select className="input" value={one?.data.font || DEFAULT_FONT}
              style={{ fontFamily: fontStack(one?.data.font || DEFAULT_FONT) }}
              onChange={(e) => onPatch({ data: { font: e.target.value } })}>
              {FONTS.map((f) => (
                <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>{f.name} · {f.kind}</option>
              ))}
            </select>
            <span className="hint">Set per note. The interface font in Appearance does not touch these.</span>
          </div>
          <Slider label="Size" min={9} max={120} value={one?.data.size ?? 16} onChange={(v) => onPatch({ data: { size: v } })} />
          <div className="seg">
            {['left', 'center', 'right'].map((a) => (
              <button key={a} className={(one?.data.align || 'left') === a ? 'on' : ''} onClick={() => onPatch({ data: { align: a } })}>{a}</button>
            ))}
          </div>
          <div className="seg">
            {[['none', 'Clear'], ['panel', 'Panel'], ['brass', 'Highlight']].map(([v, l]) => (
              <button key={v} className={(one?.data.bg || 'panel') === v ? 'on' : ''} onClick={() => onPatch({ data: { bg: v } })}>{l}</button>
            ))}
          </div>
          <div className="swatches">
            {TEXT_COLOURS.map((c) => (
              <button key={c} className={`swatch${one?.data.colour === c ? ' on' : ''}`} style={{ background: c }}
                aria-label={`Text colour ${c}`} onClick={() => onPatch({ data: { colour: c } })} />
            ))}
          </div>
        </div>
      )}

      {kind === 'frame' && (
        <div className="sec">
          <span className="eyebrow">Frame</span>
          {one && (
            <div className="field">
              <label>Label</label>
              <CommitInput key={`${one.id}-label`} value={one.data.label}
                onCommit={(v) => onPatch({ data: { label: v } })} />
            </div>
          )}
          <div className="swatches">
            {FRAME_COLOURS.map((c) => (
              <button key={c} className={`swatch${one?.data.colour === c ? ' on' : ''}`} style={{ background: c }}
                aria-label={`Frame colour ${c}`} onClick={() => onPatch({ data: { colour: c } })} />
            ))}
          </div>
        </div>
      )}

      {kind === 'board' && one && (
        <div className="sec">
          <span className="eyebrow">Nested board</span>
          <div className="field">
            <label>Name</label>
            <CommitInput key={`${one.id}-boardname`} value={one.data.name}
              onCommit={(v) => onRenameBoard(v.trim())} />
          </div>
          <button className="btn" onClick={onEnter}><Icon.Board /> Open this board</button>
          <p className="hint" style={{ margin: 0 }}>Boards nest as deep as you like. Double-click the tile to go in.</p>
        </div>
      )}
    </aside>
  );
}

function Slider({ label, min, max, value, onChange }) {
  return (
    <div className="field">
      <div className="row between">
        <label>{label}</label>
        <span className="mono hint">{value}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))}
        style={{ accentColor: 'var(--brass)', width: '100%' }} />
    </div>
  );
}

function UrlImport({ projectId, onClose, onAdded }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true); setError('');
    try {
      const { image } = await api.post(`/api/images/project/${projectId}/from-url`, { url });
      onAdded(image);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <Modal title="Add an image from the web" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={go} disabled={busy}>Fetch image</button>
      </>}>
      <div className="field">
        <label>Image address</label>
        <input className="input" value={url} autoFocus placeholder="https://…/reference.jpg"
          onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      </div>
      <p className="hint" style={{ margin: 0 }}>The file is copied onto your server, so the board keeps working if the source disappears.</p>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
