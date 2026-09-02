import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Search results carry the id of the thing that matched in the query string —
 * `?focus=<id>` on a canvas, `?card=<id>` on the task board. Landing on the
 * right board is only half the job: on a canvas that may be metres wide, the
 * thing you searched for has to end up under your eyes and selected.
 *
 * The list arrives asynchronously, so this waits for the id to show up in it
 * rather than firing once and giving up. Once it has acted, the parameter is
 * taken back out of the URL — a reload should not keep dragging the viewport
 * around, and the address someone copies should be the board rather than one
 * item on it.
 *
 * The callback is held in a ref, so callers do not have to memoise it to avoid
 * re-framing on every render.
 */
export function useFocusTarget(items, onFocus, param = 'focus') {
  const loc = useLocation();
  const nav = useNavigate();
  const handled = useRef(null);
  const handler = useRef(onFocus);
  handler.current = onFocus;

  const wanted = new URLSearchParams(loc.search).get(param);

  useEffect(() => {
    if (!wanted || handled.current === wanted) return;
    const hit = items.find((i) => i.id === wanted);
    if (!hit) return; // still loading, or it has been deleted since

    handled.current = wanted;
    handler.current(hit);
    nav(loc.pathname, { replace: true });
  }, [wanted, items, nav, loc.pathname]);
}
