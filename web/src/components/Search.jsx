import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Icon } from './ui.jsx';

const DEBOUNCE_MS = 180;
const MIN_LENGTH = 2;

const KINDS = {
  project: { label: 'Project', icon: <Icon.Board /> },
  board: { label: 'Board', icon: <Icon.Board /> },
  note: { label: 'Note', icon: <Icon.Text /> },
  card: { label: 'Card', icon: <Icon.Script /> },
  beat: { label: 'Beat', icon: <Icon.Node /> },
  image: { label: 'Image', icon: <Icon.Image /> },
};

/**
 * Ctrl/Cmd+K from anywhere. One query covers notes on a board, cards, story
 * beats, board names, project names and uploaded filenames — the point being
 * that a thought written down eight months ago is findable without first
 * remembering which of the three tabs it went into.
 */
export default function Search({ open, onClose, projectId, projectName }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [scoped, setScoped] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const nav = useNavigate();

  // a query that comes back after a newer one must not overwrite it
  const latest = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    setCursor(0);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) { setQuery(''); setResults([]); setScoped(false); }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const term = query.trim();
    if (term.length < MIN_LENGTH) { setResults([]); setBusy(false); return undefined; }

    setBusy(true);
    const ticket = latest.current + 1;
    latest.current = ticket;

    const timer = setTimeout(async () => {
      try {
        const scope = scoped && projectId ? `&projectId=${encodeURIComponent(projectId)}` : '';
        const res = await api.get(`/api/search?q=${encodeURIComponent(term)}${scope}`);
        if (latest.current !== ticket) return;
        setResults(res.results);
        setCursor(0);
      } catch {
        if (latest.current === ticket) setResults([]);
      } finally {
        if (latest.current === ticket) setBusy(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, open, scoped, projectId]);

  const go = useCallback((hit) => {
    if (!hit) return;
    onClose();
    nav(hit.href);
  }, [nav, onClose]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[cursor]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // keep the highlighted row on screen when arrowing past the fold
  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, results]);

  const grouped = useMemo(() => {
    const order = ['project', 'board', 'note', 'card', 'beat', 'image'];
    const buckets = new Map(order.map((k) => [k, []]));
    results.forEach((hit, index) => buckets.get(hit.kind)?.push({ ...hit, index }));
    return order.map((kind) => [kind, buckets.get(kind)]).filter(([, rows]) => rows.length);
  }, [results]);

  if (!open) return null;

  const short = query.trim().length > 0 && query.trim().length < MIN_LENGTH;

  return (
    <div className="overlay search-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card search-panel" role="dialog" aria-modal="true" aria-label="Search">
        <div className="search-head">
          <Icon.Zoom />
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder="Search notes, cards, beats, boards…"
            aria-label="Search everything"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy && <div className="spin" />}
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><Icon.Close /></button>
        </div>

        {projectId && (
          <div className="search-scope">
            <button className={scoped ? '' : 'on'} onClick={() => setScoped(false)}>Everything</button>
            <button className={scoped ? 'on' : ''} onClick={() => setScoped(true)}>
              {projectName || 'This project'} only
            </button>
          </div>
        )}

        <div className="search-results" ref={listRef}>
          {short && <p className="hint search-empty">Two characters or more.</p>}

          {!short && !busy && query.trim().length >= MIN_LENGTH && !results.length && (
            <p className="hint search-empty">Nothing matched “{query.trim()}”.</p>
          )}

          {!query.trim() && (
            <p className="hint search-empty">
              Type to search across every project — notes on a board, cards, story beats,
              board names and uploaded filenames.
            </p>
          )}

          {grouped.map(([kind, rows]) => (
            <section key={kind}>
              <div className="eyebrow search-group">{KINDS[kind].label}</div>
              {rows.map((hit) => (
                <button
                  key={`${hit.kind}:${hit.id}`}
                  className={`search-hit${hit.index === cursor ? ' on' : ''}`}
                  onPointerEnter={() => setCursor(hit.index)}
                  onClick={() => go(hit)}
                >
                  <span className="ico">{KINDS[kind].icon}</span>
                  <span className="body">
                    <span className="title">{hit.title}</span>
                    {hit.snippet && <span className="snip">{hit.snippet}</span>}
                  </span>
                  <span className="where mono">{hit.projectName}</span>
                </button>
              ))}
            </section>
          ))}
        </div>

        <div className="search-foot hint mono">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The shortcut, kept out of the panel so it works whether or not the panel is
 * mounted. Ignored while someone is typing into a field, so Ctrl+K in a note
 * still belongs to the note.
 */
export function useSearchShortcut(onOpen) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
}
