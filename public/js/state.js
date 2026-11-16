// One store for the whole page. Views subscribe and redraw their own part; nothing else holds app state.

/** A minimal observable store: get(), set(patch), subscribe(fn) -> unsubscribe. */
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      const changed = Object.keys(next).filter((k) => next[k] !== state[k]);
      if (!changed.length) return;
      state = next;
      for (const fn of subs) fn(state, changed);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const store = createStore({
  /** GET /api/health: model, search, timezone, server "now", demo clock, watchlist. null until loaded. */
  health: null,
  /** Why the server can't be reached (null = fine). */
  serverError: null,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  sessions: [],
  sessionId: null,
  /** A turn is streaming. */
  busy: false,
  sidebarOpen: false,
});
