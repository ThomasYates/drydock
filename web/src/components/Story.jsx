import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { gridStyle, useViewport } from '../lib/canvas.js';
import { useFocusTarget } from '../lib/focus.js';
import { live, useRoom } from '../lib/realtime.js';
import { Icon, Peers, useToast } from './ui.jsx';
import { CommitInput, ContextMenu, NumberField, useContextMenu } from './controls.jsx';
import { PeerCursors, usePeerCursors } from './Cursors.jsx';

const TYPES = {
  beat:      { label: 'Beat',      colour: '#e2a445', hint: 'A scene or story moment' },
  dialogue:  { label: 'Dialogue',  colour: '#59c2d6', hint: 'Spoken lines' },
  choice:    { label: 'Choice',    colour: '#9a8cf0', hint: 'The player picks a branch' },
  condition: { label: 'Condition', colour: '#6fbf8b', hint: 'Branches on world state' },
  ending:    { label: 'Ending',    colour: '#e0685f', hint: 'A terminal state' },
  note:      { label: 'Note',      colour: '#7f8fa3', hint: 'Off-graph reminder' },
  entry:     { label: 'Way in',    colour: '#6fbf8b', hint: 'Mirrors an input on the node above' },
  exit:      { label: 'Way out',   colour: '#e0685f', hint: 'Mirrors an output on the node above' },
};
const PLACEABLE = ['beat', 'dialogue', 'choice', 'condition', 'ending', 'note'];
const isMarker = (n) => n.type === 'entry' || n.type === 'exit';
const uid = () => Math.random().toString(36).slice(2, 9);

/** Survives moving between pages, so you can copy here and paste in a planner. */
let clipboard = { nodes: [], edges: [] };

export default function Story({ projectId }) {
  const { graphId } = useParams();
  const nav = useNavigate();
  const [graphs, setGraphs] = useState([]);

  const loadGraphs = useCallback(async () => {
    const r = await api.get(`/api/story/project/${projectId}/graphs`);
    setGraphs(r.graphs);
    return r.graphs;
  }, [projectId]);

  useEffect(() => {
    loadGraphs()
      .then((list) => {
        if (!graphId && list[0]) nav(`/p/${projectId}/story/${list[0].id}`, { replace: true });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadGraphs]);

  // pushing a real history entry is what makes the browser's back button — and
  // the side buttons on a mouse — walk out of a planner page
  const open = useCallback((id) => nav(`/p/${projectId}/story/${id}`), [nav, projectId]);

  if (!graphId) return <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}><div className="spin" /></div>;

  return (
    <GraphPage
      key={graphId}
      graphId={graphId}
      threads={graphs}
      onOpen={open}
      onThreadsChanged={loadGraphs}
      projectId={projectId}
    />
  );
}

function GraphPage({ graphId, threads, onOpen, onThreadsChanged, projectId }) {
  const stage = useRef(null);
  const view = useViewport(stage, `graph-${graphId}`);
  const { vp } = view;
  const say = useToast();
  const ctx = useContextMenu();

  const [graph, setGraph] = useState(null);
  const [trail, setTrail] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const [selEdge, setSelEdge] = useState(null);
  const [link, setLink] = useState(null);
  const [script, setScript] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [ghosts, setGhosts] = useState({});
  const pointerAt = useRef({ x: 0, y: 0 });
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const linkRef = useRef(link);
  linkRef.current = link;

  const geom = useRef(new Map());
  const sizes = useRef(new Map());
  const [, bump] = useState(0);

  const room = `graph:${graphId}`;
  const cursor = usePeerCursors(room, view.toWorld);
  const holding = useRef(0);

  const load = useCallback(async () => {
    const r = await api.get(`/api/story/graphs/${graphId}`);
    setGraph(r.graph);
    setTrail(r.trail);
    setNodes(r.nodes);
    setEdges(r.edges);
  }, [graphId]);

  useEffect(() => { setSel(new Set()); setLink(null); load().catch(() => {}); }, [load]);

  // arriving from a search result: frame the beat and select it
  useFocusTarget(nodes, (node) => {
    view.fit({ x: node.x, y: node.y, w: node.w || 280, h: node.h || 180 }, 240);
    setSel(new Set([node.id]));
  });

  const peers = useRoom(room, {
    onResync: load,
    onLive: (msg) => {
      cursor.receive(msg);
      if (msg.data?.kind === 'move') {
        setGhosts((g) => {
          const n = { ...g };
          for (const m of msg.data.moves) n[m.id] = { x: m.x, y: m.y, by: msg.user.name, accent: msg.user.accent };
          return n;
        });
      } else if (msg.data?.kind === 'moveEnd') {
        setGhosts((g) => { const n = { ...g }; for (const id of msg.data.ids) delete n[id]; return n; });
      }
    },
    onOp: (op) => {
      if (op.kind === 'node.create') setNodes((s) => (s.some((n) => n.id === op.node.id) ? s : [...s, op.node]));
      else if (op.kind === 'node.update') setNodes((s) => s.map((n) => (n.id === op.node.id ? op.node : n)));
      else if (op.kind === 'node.planner') setNodes((s) => s.map((n) => (n.id === op.id ? { ...n, hasPlanner: true } : n)));
      else if (op.kind === 'node.move') {
        setNodes((s) => s.map((n) => { const m = op.moves.find((x) => x.id === n.id); return m ? { ...n, x: m.x, y: m.y } : n; }));
        setGhosts((g) => { const n = { ...g }; for (const m of op.moves) delete n[m.id]; return n; });
      } else if (op.kind === 'node.delete') {
        setNodes((s) => s.filter((n) => n.id !== op.id));
        setEdges((s) => s.filter((e) => e.from_node !== op.id && e.to_node !== op.id));
      } else if (op.kind === 'edge.create') setEdges((s) => (s.some((e) => e.id === op.edge.id) ? s : [...s, op.edge]));
      else if (op.kind === 'edge.delete') setEdges((s) => s.filter((e) => e.id !== op.id));
      else if (op.kind === 'graph.rename') setGraph((g) => (g ? { ...g, name: op.name } : g));
    },
  });

  useEffect(() => {
    const here = new Set(peers.map((p) => p.clientId));
    for (const id of Object.keys(cursor.cursors)) if (!here.has(id)) cursor.forget(id);
  }, [peers, cursor]);

  /* ── measure port positions after every paint ─────────── */
  // Deliberately unguarded: a card resizes itself to its content, so the
  // only honest time to read where its ports ended up is after every paint.
  // `changed` below is what stops it looping — state is only set when a
  // measurement actually moved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    let changed = false;
    for (const node of nodesRef.current) {
      const el = document.querySelector(`[data-node="${node.id}"]`);
      if (!el) continue;
      const h = el.offsetHeight;
      if (sizes.current.get(node.id) !== h) { sizes.current.set(node.id, h); changed = true; }
      for (const dot of el.querySelectorAll('[data-port]')) {
        let dx = dot.offsetWidth / 2;
        let dy = dot.offsetHeight / 2;
        let cur = dot;
        while (cur && cur !== el) { dx += cur.offsetLeft; dy += cur.offsetTop; cur = cur.offsetParent; }
        const key = `${node.id}:${dot.dataset.port}`;
        const prev = geom.current.get(key);
        if (!prev || Math.abs(prev.dx - dx) > 0.5 || Math.abs(prev.dy - dy) > 0.5) {
          geom.current.set(key, { dx, dy });
          changed = true;
        }
      }
    }
    if (changed) bump((n) => n + 1);
  });

  const anchor = useCallback((nodeId, side, portId) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return null;
    const pos = ghosts[nodeId] || node;
    const g = geom.current.get(`${nodeId}:${side}:${portId}`);
    if (!g) return { x: pos.x + (side === 'in' ? 0 : node.w), y: pos.y + 20 };
    return { x: pos.x + g.dx, y: pos.y + g.dy };
  }, [ghosts]);

  const screen = useCallback((w) => ({ x: w.x * vp.k + vp.x, y: w.y * vp.k + vp.y }), [vp]);
  const centre = () => {
    const r = stage.current.getBoundingClientRect();
    return { x: (r.width / 2 - vp.x) / vp.k, y: (r.height / 2 - vp.y) / vp.k };
  };

  /* ── mutations ────────────────────────────────────────── */
  const addNode = useCallback(async (partial) => {
    const { node } = await api.post(`/api/story/graphs/${graphId}/nodes`, partial);
    setNodes((s) => [...s, node]);
    setSel(new Set([node.id]));
    return node;
  }, [graphId]);

  const patchNode = useCallback(async (id, patch) => {
    setNodes((s) => s.map((n) => (n.id === id
      ? { ...n, ...patch, data: patch.data ? { ...n.data, ...patch.data } : n.data }
      : n)));
    try {
      const { node } = await api.patch(`/api/story/nodes/${id}`, patch);
      setNodes((s) => s.map((n) => (n.id === id ? node : n)));
      setEdges((s) => s.filter((e) => {
        if (e.from_node === id) return node.data.outputs.some((p) => p.id === e.from_port);
        if (e.to_node === id) return node.data.inputs.some((p) => p.id === e.to_port);
        return true;
      }));
    } catch (e) { say(e.message); load(); }
  }, [say, load]);

  const removeNodes = useCallback(async (ids) => {
    const targets = nodesRef.current.filter((n) => ids.includes(n.id) && !isMarker(n));
    if (!targets.length) {
      if (ids.length) say('Markers follow the ports on the node above — remove the port instead');
      return;
    }
    const planned = targets.filter((n) => n.hasPlanner);
    if (planned.length && !confirm(`${planned.map((n) => `“${n.title}”`).join(', ')} ${planned.length > 1 ? 'have planner pages' : 'has a planner page'}. Delete everything inside too?`)) return;
    const gone = targets.map((n) => n.id);
    setNodes((s) => s.filter((n) => !gone.includes(n.id)));
    setEdges((s) => s.filter((e) => !gone.includes(e.from_node) && !gone.includes(e.to_node)));
    setSel(new Set());
    await Promise.all(gone.map((id) => api.del(`/api/story/nodes/${id}`).catch(() => {})));
  }, [say]);

  const joinUp = useCallback(async (fromNode, fromPort, toNode, toPort) => {
    try {
      const { edge } = await api.post(`/api/story/graphs/${graphId}/edges`, { fromNode, fromPort, toNode, toPort });
      setEdges((s) => [...s, edge]);
    } catch (e) { say(e.message); }
  }, [graphId, say]);

  const dropEdge = useCallback(async (id) => {
    setEdges((s) => s.filter((e) => e.id !== id));
    setSelEdge(null);
    await api.del(`/api/story/edges/${id}`).catch(() => {});
  }, []);

  const openPlanner = useCallback(async (node) => {
    try {
      const { graph: page } = await api.post(`/api/story/nodes/${node.id}/planner`);
      setNodes((s) => s.map((n) => (n.id === node.id ? { ...n, hasPlanner: true } : n)));
      onOpen(page.id);
    } catch (e) { say(e.message); }
  }, [onOpen, say]);

  /* ── linking ──────────────────────────────────────────── */

  /** Which card is under this point, worked out from its own coordinates. */
  const nodeAt = useCallback((clientX, clientY) => {
    const w = view.toWorld(clientX, clientY);
    const list = nodesRef.current;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const n = list[i];
      const height = n.h || sizes.current.get(n.id) || 150;
      if (w.x >= n.x && w.x <= n.x + n.w && w.y >= n.y && w.y <= n.y + height) return n;
    }
    return null;
  }, [view]);

  /**
   * Hit-testing first, so dropping straight onto a dot picks that exact port.
   * If anything is in the way — an overlay, another link's hit area — fall back
   * to the card's own coordinates rather than quietly doing nothing.
   */
  const hitTarget = useCallback((clientX, clientY) => {
    const el = document.elementFromPoint?.(clientX, clientY);
    const dot = el?.closest?.('[data-port]');
    const host = el?.closest?.('[data-node]');
    if (host) {
      const [side, portId] = dot ? dot.dataset.port.split(':') : [null, null];
      return { nodeId: host.dataset.node, side, portId };
    }
    const geo = nodeAt(clientX, clientY);
    return geo ? { nodeId: geo.id, side: null, portId: null } : null;
  }, [nodeAt]);

  /** Returns 'done', 'itself' or 'nothing'. */
  const finishLink = useCallback((clientX, clientY) => {
    const start = linkRef.current;
    if (!start) return 'nothing';
    const hit = hitTarget(clientX, clientY);
    if (!hit) return 'nothing';
    if (hit.nodeId === start.nodeId) return 'itself';
    const target = nodesRef.current.find((n) => n.id === hit.nodeId);
    if (!target) return 'nothing';

    if (start.side === 'out') {
      const port = hit.side === 'in' ? hit.portId : target.data.inputs[0]?.id;
      if (!port) { say(`“${target.title}” has no way in to link to`); return 'done'; }
      joinUp(start.nodeId, start.portId, hit.nodeId, port);
    } else {
      const port = hit.side === 'out' ? hit.portId : target.data.outputs[0]?.id;
      if (!port) { say(`“${target.title}” has no way out to link from`); return 'done'; }
      joinUp(hit.nodeId, port, start.nodeId, start.portId);
    }
    return 'done';
  }, [joinUp, say, hitTarget]);

  const beginLink = (e, node, side, portId) => {
    e.stopPropagation();
    e.preventDefault();
    // already carrying a link? this dot is the destination
    if (linkRef.current?.armed) {
      finishLink(e.clientX, e.clientY);
      setLink(null);
      return;
    }
    const from = anchor(node.id, side, portId);
    const startedAt = { x: e.clientX, y: e.clientY };
    setLink({ nodeId: node.id, side, portId, from, to: from, armed: false });

    const move = (ev) => setLink((l) => (l
      ? { ...l, to: view.toWorld(ev.clientX, ev.clientY), over: nodeAt(ev.clientX, ev.clientY)?.id || null }
      : l));
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      const travelled = Math.hypot(ev.clientX - startedAt.x, ev.clientY - startedAt.y);
      const outcome = finishLink(ev.clientX, ev.clientY);
      if (outcome === 'done') { setLink(null); return; }
      // a tap rather than a drag: hold the link and wait for a second click
      if (travelled < 5) { setLink((l) => (l ? { ...l, armed: true, over: null } : l)); return; }
      if (outcome === 'itself') say('Drop it on a different node');
      else if (travelled > 20) say('Nothing there to link to');
      setLink(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  // while armed, follow the pointer and complete on the next click
  useEffect(() => {
    if (!link?.armed) return undefined;
    const move = (ev) => setLink((l) => (l
      ? { ...l, to: view.toWorld(ev.clientX, ev.clientY), over: nodeAt(ev.clientX, ev.clientY)?.id || null }
      : l));
    const click = (ev) => {
      finishLink(ev.clientX, ev.clientY);
      setLink(null);
    };
    const key = (ev) => { if (ev.key === 'Escape') setLink(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', click);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', click);
      window.removeEventListener('keydown', key);
    };
  }, [link?.armed, finishLink, view, nodeAt]);

  /* ── dragging and resizing ────────────────────────────── */
  const dragNode = (e, node) => {
    if (view.maybePan(e)) return;
    if (e.button !== 0 || link?.armed) return;
    e.stopPropagation();
    setSelEdge(null);
    let chosen = sel;
    if (e.shiftKey) {
      chosen = new Set(sel);
      if (chosen.has(node.id)) chosen.delete(node.id); else chosen.add(node.id);
      setSel(chosen);
      return;
    }
    if (!sel.has(node.id)) { chosen = new Set([node.id]); setSel(chosen); }

    const start = view.toWorld(e.clientX, e.clientY);
    const snap = nodesRef.current.filter((n) => chosen.has(n.id)).map((n) => ({ id: n.id, x: n.x, y: n.y }));
    let last = 0;
    let moved = false;
    holding.current = snap.length;

    const move = (ev) => {
      const nowAt = view.toWorld(ev.clientX, ev.clientY);
      const dx = nowAt.x - start.x;
      const dy = nowAt.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      const moves = snap.map((s) => ({ id: s.id, x: Math.round(s.x + dx), y: Math.round(s.y + dy) }));
      setNodes((list) => list.map((n) => { const m = moves.find((x) => x.id === n.id); return m ? { ...n, x: m.x, y: m.y } : n; }));
      if (Date.now() - last > 45) { last = Date.now(); live(room, { kind: 'move', moves }); }
    };
    const end = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      holding.current = 0;
      live(room, { kind: 'moveEnd', ids: snap.map((s) => s.id) });
      if (!moved) return;
      const moves = nodesRef.current.filter((n) => chosen.has(n.id)).map((n) => ({ id: n.id, x: n.x, y: n.y }));
      await api.post('/api/story/nodes/move', { moves }).catch(() => {});
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const resizeNode = (e, node) => {
    e.stopPropagation();
    e.preventDefault();
    const start = view.toWorld(e.clientX, e.clientY);
    const from = { w: node.w, h: node.h || sizes.current.get(node.id) || 160 };
    const move = (ev) => {
      const nowAt = view.toWorld(ev.clientX, ev.clientY);
      const w = Math.max(180, Math.round(from.w + (nowAt.x - start.x)));
      const h = Math.max(90, Math.round(from.h + (nowAt.y - start.y)));
      setNodes((list) => list.map((n) => (n.id === node.id ? { ...n, w, h } : n)));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      const nowNode = nodesRef.current.find((n) => n.id === node.id);
      if (nowNode) patchNode(node.id, { w: nowNode.w, h: nowNode.h });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  /** Drag across empty canvas to lasso a group of nodes. */
  const onStageDown = (e) => {
    if (view.maybePan(e)) return;
    if (e.button !== 0 || link?.armed) return;
    setSelEdge(null);
    const additive = e.shiftKey;
    if (!additive) setSel(new Set());

    const start = view.toWorld(e.clientX, e.clientY);
    const box = (ev) => {
      const at = view.toWorld(ev.clientX, ev.clientY);
      return {
        x: Math.min(start.x, at.x), y: Math.min(start.y, at.y),
        w: Math.abs(at.x - start.x), h: Math.abs(at.y - start.y),
      };
    };
    const move = (ev) => setMarquee(box(ev));
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      const area = box(ev);
      setMarquee(null);
      if (area.w < 4 && area.h < 4) return;
      const caught = nodesRef.current.filter((n) => {
        const height = n.h || sizes.current.get(n.id) || 150;
        return n.x < area.x + area.w && n.x + n.w > area.x
            && n.y < area.y + area.h && n.y + height > area.y;
      });
      setSel((prev) => new Set(additive ? [...prev, ...caught.map((n) => n.id)] : caught.map((n) => n.id)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  /** Copy the selection, keeping any links that run between the copied nodes. */
  const copySelection = useCallback(() => {
    const picked = nodesRef.current.filter((n) => sel.has(n.id) && !isMarker(n));
    if (!picked.length) return false;
    const ids = new Set(picked.map((n) => n.id));
    clipboard = {
      nodes: picked.map((n) => ({
        type: n.type, title: n.title, body: n.body, w: n.w, h: n.h,
        x: n.x, y: n.y, data: { inputs: n.data.inputs, outputs: n.data.outputs },
        ref: n.id,
      })),
      edges: edges
        .filter((e) => ids.has(e.from_node) && ids.has(e.to_node))
        .map((e) => ({ from: e.from_node, fromPort: e.from_port, to: e.to_node, toPort: e.to_port })),
    };
    say(`Copied ${picked.length} node${picked.length > 1 ? 's' : ''}`);
    return true;
  }, [sel, edges, say]);

  /** Drop the clipboard under the pointer, keeping its shape and its links. */
  const pasteClipboard = useCallback(async () => {
    if (!clipboard.nodes.length) return;
    const at = view.toWorld(pointerAt.current.x, pointerAt.current.y);
    const originX = Math.min(...clipboard.nodes.map((n) => n.x));
    const originY = Math.min(...clipboard.nodes.map((n) => n.y));

    const made = [];
    for (const source of clipboard.nodes) {
      // fresh port ids, but remember which old one each came from
      const inputs = source.data.inputs.map((port) => ({ ...port, id: uid(), was: port.id }));
      const outputs = source.data.outputs.map((port) => ({ ...port, id: uid(), was: port.id }));
      let made2;
      try {
        made2 = await api.post(`/api/story/graphs/${graphId}/nodes`, {
          type: source.type, title: source.title, body: source.body,
          w: source.w, h: source.h,
          x: Math.round(at.x + (source.x - originX)),
          y: Math.round(at.y + (source.y - originY)),
          data: {
            inputs: inputs.map(({ id, label }) => ({ id, label })),
            outputs: outputs.map(({ id, label }) => ({ id, label })),
          },
        });
      } catch (err) {
        say(err.message);
        break;
      }
      if (!made2?.node) break;
      made.push({ node: made2.node, ref: source.ref, inputs, outputs });
    }
    if (!made.length) return;

    setNodes((list) => [...list, ...made.map((m) => m.node)]);
    setSel(new Set(made.map((m) => m.node.id)));

    const lookup = new Map(made.map((m) => [m.ref, m]));
    for (const link of clipboard.edges) {
      const from = lookup.get(link.from);
      const to = lookup.get(link.to);
      if (!from || !to) continue;
      const fromPort = from.outputs.find((port) => port.was === link.fromPort)?.id;
      const toPort = to.inputs.find((port) => port.was === link.toPort)?.id;
      if (!fromPort || !toPort) continue;
      try {
        const { edge } = await api.post(`/api/story/graphs/${graphId}/edges`, {
          fromNode: from.node.id, fromPort, toNode: to.node.id, toPort,
        });
        setEdges((list) => [...list, edge]);
      } catch {}
    }
    say(`Pasted ${made.length} node${made.length > 1 ? 's' : ''}`);
  }, [graphId, view, say]);

  /* ── keyboard ─────────────────────────────────────────── */
  useEffect(() => {
    const onKey = async (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName) || e.target?.isContentEditable) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (selEdge) dropEdge(selEdge); else removeNodes([...sel]);
      } else if (e.key === 'Escape') { setSel(new Set()); setSelEdge(null); setLink(null); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault(); setSel(new Set(nodesRef.current.map((n) => n.id)));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        if (copySelection()) e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        if (copySelection()) { e.preventDefault(); removeNodes([...sel]); }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault(); pasteClipboard();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (copySelection()) pasteClipboard();
      } else if (e.key === 'Tab' && sel.size === 1) {
        e.preventDefault();
        const from = nodesRef.current.find((n) => n.id === [...sel][0]);
        if (!from) return;
        const made = await addNode({ type: 'beat', title: 'New beat', x: from.x + from.w + 100, y: from.y });
        const out = from.data.outputs[0];
        if (out) joinUp(from.id, out.id, made.id, made.data.inputs[0]?.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, selEdge, removeNodes, dropEdge, addNode, joinUp, copySelection, pasteClipboard]);

  const fitAll = () => {
    if (!nodes.length) { view.fit(null); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const h = n.h || sizes.current.get(n.id) || 150;
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + h);
    }
    view.fit({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
  };

  /* ── context menus ────────────────────────────────────── */
  const canvasMenu = (e) => {
    if (view.recentlyPanned()) { e.preventDefault(); return; }
    pointerAt.current = { x: e.clientX, y: e.clientY };
    const at = view.toWorld(e.clientX, e.clientY);
    ctx.open(e, [
      ...PLACEABLE.map((type) => ({
        label: `Add ${TYPES[type].label.toLowerCase()}`,
        icon: <span className="kind" style={{ background: TYPES[type].colour, width: 8, height: 8, borderRadius: 2, display: 'block' }} />,
        onClick: () => addNode({ type, title: `New ${TYPES[type].label.toLowerCase()}`, x: Math.round(at.x), y: Math.round(at.y) }),
      })),
      { divider: true },
      clipboard.nodes.length > 0 && {
        label: `Paste ${clipboard.nodes.length} node${clipboard.nodes.length > 1 ? 's' : ''}`,
        icon: <Icon.Copy />, hint: '⌘V', onClick: pasteClipboard,
      },
      { label: 'Select everything', icon: <Icon.Frame />, hint: '⌘A', onClick: () => setSel(new Set(nodes.map((n) => n.id))) },
      { label: 'Fit to screen', icon: <Icon.Fit />, onClick: fitAll },
    ], { title: 'Add here' });
  };

  const nodeMenu = (e, node) => {
    e.stopPropagation();
    pointerAt.current = { x: e.clientX, y: e.clientY };
    if (!sel.has(node.id)) setSel(new Set([node.id]));
    ctx.open(e, [
      !isMarker(node) && { label: node.hasPlanner ? 'Open planner page' : 'Plan this out', icon: <Icon.Node />, onClick: () => openPlanner(node) },
      !isMarker(node) && { divider: true },
      !isMarker(node) && {
        label: 'Add a way in',
        icon: <Icon.Plus />,
        onClick: () => patchNode(node.id, { data: { inputs: [...node.data.inputs, { id: uid(), label: `In ${node.data.inputs.length + 1}` }] } }),
      },
      !isMarker(node) && {
        label: 'Add a way out',
        icon: <Icon.Plus />,
        onClick: () => patchNode(node.id, { data: { outputs: [...node.data.outputs, { id: uid(), label: `Out ${node.data.outputs.length + 1}` }] } }),
      },
      !isMarker(node) && { label: sel.size > 1 ? `Copy ${sel.size} nodes` : 'Copy', icon: <Icon.Copy />, hint: '⌘C', onClick: copySelection },
      clipboard.nodes.length > 0 && { label: 'Paste', icon: <Icon.Copy />, hint: '⌘V', onClick: pasteClipboard },
      !isMarker(node) && {
        label: 'Duplicate', icon: <Icon.Copy />, hint: '⌘D',
        onClick: () => { if (copySelection()) pasteClipboard(); },
      },
      node.h > 0 && { label: 'Let it size itself', icon: <Icon.Fit />, onClick: () => patchNode(node.id, { h: 0 }) },
      { divider: true },
      { label: 'Delete', icon: <Icon.Trash />, danger: true, disabled: isMarker(node), onClick: () => removeNodes([node.id]) },
    ], { title: node.title });
  };

  const selectedNode = sel.size === 1 ? nodes.find((n) => n.id === [...sel][0]) : null;
  const incoming = useMemo(() => new Set(edges.map((e) => e.to_node)), [edges]);
  const linking = !!link;

  return (
    <>
      <div ref={stage} className={`stage${view.panning ? ' grabbing' : ''}`}
        onPointerDown={onStageDown}
        onPointerMove={(e) => {
          pointerAt.current = { x: e.clientX, y: e.clientY };
          cursor.onPointerMove(e, holding.current);
        }}
        onPointerLeave={cursor.onPointerLeave}
        onContextMenu={canvasMenu}>
        <div className="stage-grid" style={gridStyle(vp)} />

        {/* width and height must be explicit: an svg without them falls back to
            300x150 and silently clips every wire that runs past it */}
        <svg className={`edges${link ? ' linking' : ''}`} width="100%" height="100%">
          {edges.map((e) => {
            const a = anchor(e.from_node, 'out', e.from_port);
            const b = anchor(e.to_node, 'in', e.to_port);
            if (!a || !b) return null;
            const p1 = screen(a);
            const p2 = screen(b);
            const bow = Math.max(45, Math.abs(p2.x - p1.x) * 0.45);
            const d = `M ${p1.x} ${p1.y} C ${p1.x + bow} ${p1.y}, ${p2.x - bow} ${p2.y}, ${p2.x} ${p2.y}`;
            return (
              <g key={e.id}>
                <path d={d} className={selEdge === e.id ? 'sel' : ''} />
                <path d={d} className="hit" onPointerDown={(ev) => { ev.stopPropagation(); setSelEdge(e.id); setSel(new Set()); }} />
                <circle cx={p2.x} cy={p2.y} r="3.5" fill={selEdge === e.id ? '#e2a445' : '#59c2d6'} />
              </g>
            );
          })}
          {link && (() => {
            const p1 = screen(link.from);
            const p2 = screen(link.to);
            const bow = Math.max(45, Math.abs(p2.x - p1.x) * 0.45);
            const flip = link.side === 'in' ? -1 : 1;
            return <path d={`M ${p1.x} ${p1.y} C ${p1.x + bow * flip} ${p1.y}, ${p2.x - bow * flip} ${p2.y}, ${p2.x} ${p2.y}`}
              style={{ stroke: '#e2a445', strokeDasharray: '6 4' }} />;
          })()}
        </svg>

        <div className="world" style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.k})` }}>
          {marquee && (
            <div className="marquee" style={{
              left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h,
              borderWidth: `${1 / vp.k}px`,
            }} />
          )}
          {nodes.map((n) => (
            <StoryNode
              key={n.id}
              node={n}
              ghost={ghosts[n.id]}
              selected={sel.has(n.id)}
              isRoot={!incoming.has(n.id)}
              linking={linking}
              isDropTarget={link?.over === n.id && link?.nodeId !== n.id}
              linkFrom={link?.nodeId === n.id ? link.portId : null}
              onPointerDown={(e) => dragNode(e, n)}
              onContextMenu={(e) => nodeMenu(e, n)}
              onPortDown={(e, side, portId) => beginLink(e, n, side, portId)}
              onResize={(e) => resizeNode(e, n)}
              onOpenPlanner={() => openPlanner(n)}
            />
          ))}
        </div>

        <PeerCursors cursors={cursor.cursors} vp={vp} />

        {link?.armed && (
          <div className="link-hint">
            Now click where it should go — Escape to drop it
          </div>
        )}

        <div className="toolbar">
          <div className="toolgroup">
            {trail.length > 1 ? (
              <div className="crumbs">
                {trail.map((t, i) => (
                  <span key={t.id} style={{ display: 'contents' }}>
                    {i > 0 && <span className="sep">›</span>}
                    {i === trail.length - 1
                      ? <span className="now">{t.name}</span>
                      : <button onClick={() => onOpen(t.id)}>{t.name}</button>}
                  </span>
                ))}
              </div>
            ) : (
              <select className="input" style={{ height: 26, padding: '0 24px 0 8px', fontSize: 12, border: 0, background: 'transparent' }}
                value={graphId} onChange={(e) => onOpen(e.target.value)}>
                {threads.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            )}
            <button className="btn sm icon" title="New story thread" onClick={async () => {
              const name = prompt('Name this thread', 'Side thread');
              if (!name?.trim()) return;
              const { graph: made } = await api.post(`/api/story/project/${projectId}/graphs`, { name });
              await onThreadsChanged();
              onOpen(made.id);
            }}><Icon.Plus /></button>
          </div>

          <div className="toolgroup">
            {PLACEABLE.map((type) => (
              <button key={type} className="btn sm" title={TYPES[type].hint} onClick={() => {
                const c = centre();
                addNode({ type, title: `New ${TYPES[type].label.toLowerCase()}`, x: Math.round(c.x - 140), y: Math.round(c.y - 60) });
              }}>
                <span className="kind" style={{ background: TYPES[type].colour, width: 7, height: 7, borderRadius: 2, display: 'block' }} />
                {TYPES[type].label}
              </button>
            ))}
          </div>

          <div className="toolgroup">
            <button className="btn sm" onClick={async () => setScript(await api.get(`/api/story/graphs/${graphId}/script`))}>
              <Icon.Script /> Read as script
            </button>
          </div>

          <Peers peers={peers} />
        </div>

        <div className="hud">
          <div className="read">
            <span>{Math.round(vp.k * 100)}%</span>
            <span style={{ color: 'var(--dim)' }}>{nodes.length} nodes · {edges.length} links</span>
            {graph?.parent_node_id && <span style={{ color: 'var(--brass)' }}>planner page</span>}
          </div>
          <button onClick={() => view.zoomToCentre(1 / 1.25)}>−</button>
          <button onClick={() => view.resetZoom()}>1:1</button>
          <button onClick={() => view.zoomToCentre(1.25)}>+</button>
          <button onClick={fitAll} title="Fit everything on screen"><Icon.Fit /></button>
          <button className={view.wheelZoom ? '' : 'on'} onClick={view.toggleWheel}
            title={view.wheelZoom ? 'Mouse wheel zooms — click to make it pan' : 'Mouse wheel pans — click to make it zoom'}>
            {view.wheelZoom ? '⌖' : '✥'}
          </button>
        </div>

        {selEdge && (
          <div style={{ position: 'absolute', right: 16, bottom: 16, zIndex: 14 }}>
            <button className="btn danger" onClick={() => dropEdge(selEdge)}><Icon.Trash /> Delete link</button>
          </div>
        )}

        {script !== null && <ScriptPanel text={script} onClose={() => setScript(null)} />}
      </div>

      {selectedNode && (
        <NodeInspector
          key={selectedNode.id}
          node={selectedNode}
          outgoing={edges.filter((e) => e.from_node === selectedNode.id)}
          incomingEdges={edges.filter((e) => e.to_node === selectedNode.id)}
          nodes={nodes}
          onPatch={(patch) => patchNode(selectedNode.id, patch)}
          onDelete={() => removeNodes([selectedNode.id])}
          onUnlink={dropEdge}
          onPlanner={() => openPlanner(selectedNode)}
        />
      )}

      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
    </>
  );
}

/* ── one node ────────────────────────────────────────────── */
function StoryNode({ node, ghost, selected, isRoot, linking, isDropTarget, linkFrom, onPointerDown, onContextMenu, onPortDown, onResize, onOpenPlanner }) {
  const t = TYPES[node.type] || TYPES.beat;
  const pos = ghost || node;
  const marker = isMarker(node);
  const style = {
    left: 0, top: 0, width: node.w,
    transform: `translate(${pos.x}px, ${pos.y}px)`,
    ...(node.h > 0 ? { height: node.h } : null),
    ...(ghost ? { borderColor: ghost.accent || '#e2a445', boxShadow: `0 0 0 1px ${ghost.accent || '#e2a445'}` } : null),
  };

  return (
    <div
      data-node={node.id}
      className={`node${selected ? ' sel' : ''}${marker ? ` marker ${node.type}` : ''}${node.h > 0 ? ' tall' : ''}${linking ? ' linkable' : ''}${isDropTarget ? ' drop-target' : ''}`}
      style={style}
      onPointerDown={(e) => { if (!e.target.closest('[data-port]') && !e.target.closest('button')) onPointerDown(e); }}
      onContextMenu={onContextMenu}
    >
      <header>
        <span className="kind" style={{ background: t.colour }} />
        <span className="t">{node.title}</span>
        {marker && <span className="chip">{node.type === 'entry' ? 'way in' : 'way out'}</span>}
        {!marker && node.hasPlanner && <span className="badge" title="This node is planned out on its own page">plan</span>}
        {!marker && isRoot && node.type !== 'note' && <span className="chip" title="Nothing links into this node">start</span>}
        {!marker && (
          <button className="plan-btn" title="Open this node up and plan the route through it"
            onPointerDown={(e) => e.stopPropagation()} onClick={onOpenPlanner}>
            <Icon.Node /> Plan
          </button>
        )}
      </header>

      {node.body && <div className="body">{node.body}</div>}

      <div className="rails">
        <ul className="rail in">
          {node.data.inputs.map((p) => (
            <li className="port-row" key={p.id}>
              <button className={`port-dot in${linkFrom === p.id ? ' live' : ''}`} data-port={`in:${p.id}`}
                title="Drag from here, or click and click again on the source"
                onPointerDown={(e) => onPortDown(e, 'in', p.id)} />
              <span>{p.label}</span>
            </li>
          ))}
        </ul>
        <ul className="rail out">
          {node.data.outputs.map((p) => (
            <li className="port-row" key={p.id}>
              <span>{p.label}</span>
              <button className={`port-dot out${linkFrom === p.id ? ' live' : ''}`} data-port={`out:${p.id}`}
                title="Drag onto another node, or click here then click the target"
                onPointerDown={(e) => onPortDown(e, 'out', p.id)} />
            </li>
          ))}
        </ul>
      </div>

      {selected && !marker && <div className="node-handle" onPointerDown={onResize} />}
      {ghost && <div className="ghost-label" style={{ background: ghost.accent || '#e2a445', top: 0 }}>{ghost.by}</div>}
    </div>
  );
}

/* ── inspector ───────────────────────────────────────────── */
function NodeInspector({ node, outgoing, incomingEdges, nodes, onPatch, onDelete, onUnlink, onPlanner }) {
  const t = TYPES[node.type];
  const marker = isMarker(node);

  const editPort = (side, id, label) => {
    const list = node.data[side].map((p) => (p.id === id ? { ...p, label } : p));
    onPatch({ data: { [side]: list } });
  };
  const addPort = (side) => {
    const list = [...node.data[side], { id: uid(), label: side === 'inputs' ? `In ${node.data.inputs.length + 1}` : `Out ${node.data.outputs.length + 1}` }];
    onPatch({ data: { [side]: list } });
  };
  const dropPort = (side, id) => {
    onPatch({ data: { [side]: node.data[side].filter((p) => p.id !== id) } });
  };

  return (
    <aside className="inspector">
      <div className="sec">
        <div className="row between">
          <span className="eyebrow">{t.label}</span>
          {!marker && <button className="btn ghost icon sm" onClick={onDelete} title="Delete node"><Icon.Trash /></button>}
        </div>

        {marker ? (
          <p className="hint" style={{ margin: 0 }}>
            This mirrors a port on the node above. Rename or remove it from that node and this follows.
          </p>
        ) : (
          <>
            <div className="field">
              <label>Title</label>
              <CommitInput value={node.title} onCommit={(v) => onPatch({ title: v })} />
            </div>
            <div className="field">
              <label>Kind</label>
              <select className="input" value={node.type} onChange={(e) => onPatch({ type: e.target.value })}>
                {PLACEABLE.map((k) => <option key={k} value={k}>{TYPES[k].label}</option>)}
              </select>
              <span className="hint">{t.hint}</span>
            </div>
            <div className="field">
              <label>Content</label>
              <CommitInput multiline allowEmpty value={node.body} style={{ minHeight: 140 }}
                placeholder={node.type === 'dialogue' ? 'VINCENT: You are up early.' : 'What happens here?'}
                onCommit={(v) => onPatch({ body: v })} />
            </div>
          </>
        )}

        <div className="row" style={{ gap: 8 }}>
          <NumberField label="W" value={Math.round(node.w)} min={180} max={900} step={10} onChange={(v) => onPatch({ w: v })} />
          <NumberField label="H" value={Math.round(node.h)} min={0} max={900} step={10} onChange={(v) => onPatch({ h: v })} />
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Height 0 lets the card size itself. Drag the corner of a selected node to set both.
        </p>
      </div>

      {!marker && (
        <>
          <div className="sec">
            <div className="row between">
              <span className="eyebrow">Ways in</span>
              <button className="btn ghost sm" onClick={() => addPort('inputs')}><Icon.Plus /> Add</button>
            </div>
            {!node.data.inputs.length && <p className="hint" style={{ margin: 0 }}>Nothing can link into this node.</p>}
            {node.data.inputs.map((p) => (
              <div className="port-editor" key={p.id}>
                <span className="grip">◀</span>
                <CommitInput value={p.label} onCommit={(v) => editPort('inputs', p.id, v)} />
                <button className="btn ghost icon sm" title="Remove this way in" onClick={() => dropPort('inputs', p.id)}><Icon.Close /></button>
              </div>
            ))}
          </div>

          <div className="sec">
            <div className="row between">
              <span className="eyebrow">Ways out</span>
              <button className="btn ghost sm" onClick={() => addPort('outputs')}><Icon.Plus /> Add</button>
            </div>
            {!node.data.outputs.length && <p className="hint" style={{ margin: 0 }}>This is a dead stop — nothing leads onward.</p>}
            {node.data.outputs.map((p) => (
              <div className="port-editor" key={p.id}>
                <CommitInput value={p.label} onCommit={(v) => editPort('outputs', p.id, v)} />
                <span className="grip">▶</span>
                <button className="btn ghost icon sm" title="Remove this way out" onClick={() => dropPort('outputs', p.id)}><Icon.Close /></button>
              </div>
            ))}
          </div>

          <div className="sec">
            <span className="eyebrow">Planner page</span>
            <button className="btn" onClick={onPlanner}>
              <Icon.Node /> {node.hasPlanner ? 'Open planner page' : 'Plan this out'}
            </button>
            <p className="hint" style={{ margin: 0 }}>
              Opens a page of its own holding one marker per port here — {node.data.inputs.length} in,{' '}
              {node.data.outputs.length} out — so you can lay out the route through this node.
            </p>
          </div>
        </>
      )}

      <div className="sec">
        <span className="eyebrow">Links</span>
        {!outgoing.length && !incomingEdges.length && (
          <p className="hint" style={{ margin: 0 }}>
            Drag from a dot on the edge of the card onto another node. Or click a dot once, then click the target.
          </p>
        )}
        {incomingEdges.map((e) => {
          const src = nodes.find((n) => n.id === e.from_node);
          return (
            <div className="row between" key={e.id}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span className="mono hint">from </span>{src?.title || '?'}
              </span>
              <button className="btn ghost icon sm" onClick={() => onUnlink(e.id)} title="Remove link"><Icon.Close /></button>
            </div>
          );
        })}
        {outgoing.map((e) => {
          const target = nodes.find((n) => n.id === e.to_node);
          const port = node.data.outputs.find((p) => p.id === e.from_port);
          return (
            <div className="row between" key={e.id}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span className="mono hint">{port?.label || e.from_port} → </span>{target?.title || '?'}
              </span>
              <button className="btn ghost icon sm" onClick={() => onUnlink(e.id)} title="Remove link"><Icon.Close /></button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function ScriptPanel({ text, onClose }) {
  const say = useToast();
  return (
    <div className="script-panel" onPointerDown={(e) => e.stopPropagation()}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--line-soft)' }}>
        <span className="eyebrow" style={{ flex: 1 }}>Every route, flattened</span>
        <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(text); say('Script copied'); }}><Icon.Copy /> Copy</button>
        <button className="btn sm" onClick={() => {
          const blob = new Blob([text], { type: 'text/markdown' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'story.md';
          a.click();
          URL.revokeObjectURL(a.href);
        }}>Download</button>
        <button className="btn ghost icon sm" onClick={onClose}><Icon.Close /></button>
      </header>
      <pre>{text}</pre>
    </div>
  );
}
