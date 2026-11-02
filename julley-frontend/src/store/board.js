import { create } from 'zustand';
import { api } from '../lib/api.js';
import { isNewer, neighboursOf, computeView } from '../lib/view.js';
import { toast } from './toasts.js';

const MAX_HISTORY = 50;
const MAX_RETRY_DELAY_MS = 15_000;
const FLASH_MS = 1600;

const toMap = (items) => Object.fromEntries(items.map((item) => [item.id, item]));

function omit(map, key) {
  if (!(key in map)) return map;
  const copy = { ...map };
  delete copy[key];
  return copy;
}

// Set by the session store, to avoid a circular import.
let nameOf = () => 'Someone';
let onBoardGone = () => {};
export function configureBoardStore(options) {
  nameOf = options.nameOf;
  onBoardGone = options.onBoardGone;
}

// --- talking to the server ----------------------------------------------------

const REQUESTS = {
  'task.create': ({ tenantId, task, afterId, beforeId, id }) =>
    api.post(
      `/tenants/${tenantId}/tasks`,
      { id: task.id, columnId: task.columnId, title: task.title, afterId, beforeId },
      { opId: id },
    ),
  'task.update': ({ tenantId, taskId, patch, baseVersion, id }) =>
    api.patch(`/tenants/${tenantId}/tasks/${taskId}`, { patch, baseVersion }, { opId: id }),
  'task.move': ({ tenantId, taskId, columnId, afterId, beforeId, baseVersion, id }) =>
    api.post(`/tenants/${tenantId}/tasks/${taskId}/move`, { columnId, afterId, beforeId, baseVersion }, { opId: id }),
  'task.delete': ({ tenantId, taskId, id }) => api.del(`/tenants/${tenantId}/tasks/${taskId}`, { opId: id }),
  'task.restore': ({ tenantId, taskId, columnId, afterId, beforeId, id }) =>
    api.post(`/tenants/${tenantId}/tasks/${taskId}/restore`, { columnId, afterId, beforeId }, { opId: id }),
  'column.create': ({ tenantId, boardId, column, afterId, beforeId, id }) =>
    api.post(
      `/tenants/${tenantId}/boards/${boardId}/columns`,
      { id: column.id, name: column.name, afterId, beforeId },
      { opId: id },
    ),
  'column.update': ({ tenantId, columnId, patch, baseVersion, id }) =>
    api.patch(`/tenants/${tenantId}/columns/${columnId}`, { patch, baseVersion }, { opId: id }),
  'column.move': ({ tenantId, columnId, afterId, beforeId, baseVersion, id }) =>
    api.post(`/tenants/${tenantId}/columns/${columnId}/move`, { afterId, beforeId, baseVersion }, { opId: id }),
  'column.delete': ({ tenantId, columnId, id }) => api.del(`/tenants/${tenantId}/columns/${columnId}`, { opId: id }),
  'column.restore': ({ tenantId, columnId, afterId, beforeId, id }) =>
    api.post(`/tenants/${tenantId}/columns/${columnId}/restore`, { afterId, beforeId }, { opId: id }),
};

// The server's latest version of an entity, used when a command doesn't pin one.
function serverVersion(state, op) {
  if (op.taskId) return state.tasks[op.taskId]?.version ?? 0;
  if (op.columnId) return state.columns[op.columnId]?.version ?? 0;
  return 0;
}

function withVersions(op, state) {
  const needsBase = ['task.update', 'task.move', 'column.update', 'column.move'].includes(op.kind);
  return needsBase ? { ...op, baseVersion: op.command.baseVersion ?? serverVersion(state, op) } : op;
}

// --- store --------------------------------------------------------------------

const EMPTY = {
  tenantId: null,
  boardId: null,
  status: 'idle', // idle | loading | ready | error
  board: null,
  columns: {},
  tasks: {},
  snapshotSeq: 0,
  openTaskId: null,
  conflict: null,
  flash: {},
};

let retryDelay = 1000;
let retryTimer = null;
let flushing = false;
let bufferedEvents = [];
let tombstones = new Map(); // id -> version: stops late responses resurrecting deletes

export const useBoard = create((set, get) => ({
  ...EMPTY,
  pending: [],
  past: [],
  future: [],
  queueStalled: false,

  // --- loading ----------------------------------------------------------------

  resetTenant(tenantId) {
    bufferedEvents = [];
    tombstones = new Map();
    set({ ...EMPTY, tenantId, past: [], future: [] });
  },

  async load(tenantId, boardId) {
    bufferedEvents = [];
    set({ ...EMPTY, tenantId, boardId, status: 'loading', flash: {} });
    try {
      const snapshot = await api.get(`/tenants/${tenantId}/boards/${boardId}`);
      if (get().boardId !== boardId) return;
      set({
        status: 'ready',
        board: snapshot.board,
        columns: toMap(snapshot.columns),
        tasks: toMap(snapshot.tasks),
        snapshotSeq: snapshot.seq,
      });
      // Whatever arrived during the fetch and isn't already in the snapshot.
      const buffered = bufferedEvents;
      bufferedEvents = [];
      for (const event of buffered) get().applyEvent(event);
    } catch (err) {
      if (get().boardId !== boardId) return;
      if (err.status === 404) {
        onBoardGone(boardId);
        return;
      }
      set({ status: 'error' });
    }
  },

  /** Reloads the current board in place, keeping pending operations and undo. */
  async refresh() {
    const { tenantId, boardId } = get();
    if (!boardId) return;
    try {
      const snapshot = await api.get(`/tenants/${tenantId}/boards/${boardId}`);
      if (get().boardId !== boardId) return;
      set({
        status: 'ready',
        board: snapshot.board,
        columns: toMap(snapshot.columns),
        tasks: toMap(snapshot.tasks),
        snapshotSeq: snapshot.seq,
      });
    } catch (err) {
      if (err.status === 404 && get().boardId === boardId) onBoardGone(boardId);
    }
  },

  // --- incoming events --------------------------------------------------------

  applyEvent(event, { myUserId } = {}) {
    const state = get();
    if (event.boardId !== state.boardId) return;
    if (state.status === 'loading') {
      bufferedEvents.push(event);
      return;
    }
    if (state.status !== 'ready' || event.seq <= state.snapshotSeq) return;

    const { task, tasks, column, board, positions, columnId } = event.payload;
    const updates = {};

    if (task) {
      if (task.deletedAt) {
        tombstones.set(task.id, task.version);
        updates.tasks = omit(state.tasks, task.id);
        if (state.openTaskId === task.id && event.actor?.id !== myUserId) {
          updates.openTaskId = null;
          toast(`${event.actor?.name ?? 'Someone'} deleted “${task.title}”`, 'warning');
        }
      } else if (isNewer(task, state.tasks[task.id])) {
        tombstones.delete(task.id);
        updates.tasks = { ...state.tasks, [task.id]: task };
      }
    }
    if (column) {
      if (column.deletedAt) {
        tombstones.set(column.id, column.version);
        updates.columns = omit(state.columns, column.id);
      } else if (isNewer(column, state.columns[column.id])) {
        tombstones.delete(column.id);
        updates.columns = { ...state.columns, [column.id]: column };
      }
    }
    if (tasks) {
      // A restored column brings its tasks back.
      updates.tasks = { ...(updates.tasks ?? state.tasks), ...toMap(tasks) };
    }
    if (board) updates.board = board;
    if (positions) {
      // Rebalancing changes keys but not order, and bumps no version.
      if (event.action === 'column.rebalanced') {
        const next = { ...(updates.tasks ?? state.tasks) };
        for (const [id, position] of Object.entries(positions)) {
          if (next[id]?.columnId === columnId) next[id] = { ...next[id], position };
        }
        updates.tasks = next;
      } else {
        const next = { ...(updates.columns ?? state.columns) };
        for (const [id, position] of Object.entries(positions)) {
          if (next[id]) next[id] = { ...next[id], position };
        }
        updates.columns = next;
      }
    }

    // A brief highlight, so a colleague's change is noticed rather than just appearing.
    const flashId = task?.id ?? column?.id;
    if (flashId && event.actor && event.actor.id !== myUserId && !task?.deletedAt) {
      updates.flash = { ...state.flash, [flashId]: event.actor.color };
      setTimeout(() => set((s) => ({ flash: omit(s.flash, flashId) })), FLASH_MS);
    }

    if (Object.keys(updates).length) set(updates);
  },

  /** A response from the server. Stricter than events: it must never overwrite newer data. */
  applyResult(result) {
    const state = get();
    const updates = {};
    const { task, column, tasks } = result ?? {};
    if (task && task.boardId === state.boardId) {
      if (task.deletedAt) {
        tombstones.set(task.id, task.version);
        updates.tasks = omit(state.tasks, task.id);
      } else if (!(tombstones.get(task.id) >= task.version) && isNewer(task, state.tasks[task.id], { strict: true })) {
        tombstones.delete(task.id);
        updates.tasks = { ...state.tasks, [task.id]: task };
      }
    }
    if (column && column.boardId === state.boardId) {
      if (column.deletedAt) {
        tombstones.set(column.id, column.version);
        updates.columns = omit(state.columns, column.id);
      } else if (!(tombstones.get(column.id) >= column.version) && isNewer(column, state.columns[column.id], { strict: true })) {
        tombstones.delete(column.id);
        updates.columns = { ...state.columns, [column.id]: column };
      }
    }
    if (tasks) updates.tasks = { ...(updates.tasks ?? state.tasks), ...toMap(tasks) };
    if (Object.keys(updates).length) set(updates);
  },

  // --- commands ---------------------------------------------------------------

  /**
   * Queues a command. It shows on screen at once, via the view, and is sent in order.
   * `history` makes it undoable: {label, undo, redo}, where each is a command.
   */
  dispatch(command, { history, fromHistory = null, onDone } = {}) {
    const { tenantId, boardId } = get();
    const op = {
      ...command,
      id: crypto.randomUUID(),
      tenantId,
      boardId,
      command,
      fromHistory,
      history,
      onDone,
    };
    set((state) => ({ pending: [...state.pending, op] }));
    if (history) {
      set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), history],
        future: [],
      }));
    }
    flushQueue();
    return op;
  },

  undo() {
    const { past } = get();
    const entry = past.at(-1);
    if (!entry) return;
    set((state) => ({ past: state.past.slice(0, -1), future: [...state.future, entry] }));
    get().dispatch(entry.undo, {
      fromHistory: 'undo',
      // The redo must expect the version this undo produces, or it would look like
      // somebody else's change.
      onDone: (result) => pinBase(entry.redo, result),
    });
  },

  redo() {
    const { future } = get();
    const entry = future.at(-1);
    if (!entry) return;
    set((state) => ({ future: state.future.slice(0, -1), past: [...state.past, entry] }));
    get().dispatch(entry.redo, {
      fromHistory: 'redo',
      onDone: (result) => pinBase(entry.undo, result),
    });
  },

  // --- actions the UI calls --------------------------------------------------

  createTask(columnId, title) {
    const state = get();
    const id = crypto.randomUUID();
    const snapshot = {
      id,
      tenantId: state.tenantId,
      boardId: state.boardId,
      columnId,
      title,
      description: '',
      priority: 'medium',
      assigneeId: null,
      dueDate: null,
      version: 0,
      fieldVersions: {},
    };
    const undo = { kind: 'task.delete', taskId: id };
    const redo = { kind: 'task.restore', taskId: id, columnId, snapshot };
    const history = { label: `add “${title}”`, undo, redo };
    get().dispatch({ kind: 'task.create', task: snapshot }, { history, onDone: (result) => {
      if (result?.task) redo.snapshot = result.task;
    } });
    return id;
  },

  updateTask(taskId, patch, baseVersion) {
    const view = selectView(get());
    const task = view.tasksById[taskId];
    if (!task) return;
    const previous = Object.fromEntries(Object.keys(patch).map((field) => [field, task[field]]));
    const undo = { kind: 'task.update', taskId, patch: previous };
    const redo = { kind: 'task.update', taskId, patch };
    const history = { label: `edit “${task.title}”`, undo, redo };
    get().dispatch(
      { kind: 'task.update', taskId, patch, baseVersion: baseVersion ?? task.version },
      { history, onDone: (result) => pinBase(undo, result) },
    );
  },

  moveTask(taskId, columnId, afterId, beforeId) {
    const view = selectView(get());
    const task = view.tasksById[taskId];
    if (!task) return;
    const from = view.columns.find((column) => column.id === task.columnId);
    const undo = { kind: 'task.move', taskId, columnId: task.columnId, ...neighboursOf(from?.tasks ?? [], taskId) };
    const redo = { kind: 'task.move', taskId, columnId, afterId, beforeId };
    const history = { label: `move “${task.title}”`, undo, redo };
    get().dispatch(
      { kind: 'task.move', taskId, columnId, afterId, beforeId, baseVersion: task.version },
      { history, onDone: (result) => pinBase(undo, result) },
    );
  },

  deleteTask(taskId) {
    const view = selectView(get());
    const task = view.tasksById[taskId];
    if (!task) return;
    const from = view.columns.find((column) => column.id === task.columnId);
    const undo = {
      kind: 'task.restore',
      taskId,
      columnId: task.columnId,
      snapshot: task,
      ...neighboursOf(from?.tasks ?? [], taskId),
    };
    const history = { label: `delete “${task.title}”`, undo, redo: { kind: 'task.delete', taskId } };
    if (get().openTaskId === taskId) set({ openTaskId: null });
    get().dispatch({ kind: 'task.delete', taskId }, { history });
  },

  createColumn(name) {
    const state = get();
    const id = crypto.randomUUID();
    const snapshot = { id, tenantId: state.tenantId, boardId: state.boardId, name, version: 0, fieldVersions: {} };
    const undo = { kind: 'column.delete', columnId: id };
    const redo = { kind: 'column.restore', columnId: id, snapshot };
    get().dispatch({ kind: 'column.create', column: snapshot }, { history: { label: `add column “${name}”`, undo, redo } });
  },

  renameColumn(columnId, name, baseVersion) {
    const column = selectView(get()).columns.find((c) => c.id === columnId);
    if (!column || column.name === name) return;
    const undo = { kind: 'column.update', columnId, patch: { name: column.name } };
    const redo = { kind: 'column.update', columnId, patch: { name } };
    get().dispatch(
      { kind: 'column.update', columnId, patch: { name }, baseVersion: baseVersion ?? column.version },
      { history: { label: `rename “${column.name}”`, undo, redo }, onDone: (result) => pinBase(undo, result) },
    );
  },

  moveColumn(columnId, afterId, beforeId) {
    const { columns } = selectView(get());
    const column = columns.find((c) => c.id === columnId);
    if (!column) return;
    const undo = { kind: 'column.move', columnId, ...neighboursOf(columns, columnId) };
    const redo = { kind: 'column.move', columnId, afterId, beforeId };
    get().dispatch(
      { kind: 'column.move', columnId, afterId, beforeId, baseVersion: column.version },
      { history: { label: `move column “${column.name}”`, undo, redo }, onDone: (result) => pinBase(undo, result) },
    );
  },

  deleteColumn(columnId) {
    const { columns } = selectView(get());
    const column = columns.find((c) => c.id === columnId);
    if (!column) return;
    const snapshot = { ...column };
    delete snapshot.tasks;
    const undo = { kind: 'column.restore', columnId, snapshot, ...neighboursOf(columns, columnId) };
    get().dispatch(
      { kind: 'column.delete', columnId },
      { history: { label: `delete column “${column.name}”`, undo, redo: { kind: 'column.delete', columnId } } },
    );
  },

  openTask(taskId) {
    set({ openTaskId: taskId });
  },

  resolveConflict(choice) {
    const { conflict } = get();
    if (!conflict) return;
    set({ conflict: null });
    if (choice === 'mine') {
      get().dispatch({
        kind: 'task.update',
        taskId: conflict.taskId,
        patch: Object.fromEntries(conflict.conflicts.map((c) => [c.field, c.yours])),
        baseVersion: conflict.current.version,
      });
    }
  },

  clearAll() {
    clearTimeout(retryTimer);
    bufferedEvents = [];
    tombstones = new Map();
    set({ ...EMPTY, pending: [], past: [], future: [], queueStalled: false });
  },

  /** Called when connectivity returns: stop waiting and try now. */
  nudgeQueue() {
    clearTimeout(retryTimer);
    retryTimer = null;
    retryDelay = 1000;
    flushQueue();
  },
}));

/** Records the version an action produced, so its undo can spot later changes by others. */
function pinBase(command, result) {
  const entity = result?.task ?? result?.column;
  if (entity) command.baseVersion = entity.version;
}

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const state = useBoard.getState();
      const op = state.pending[0];
      if (!op) return;
      if (retryTimer) return;

      const outcome = await sendOp(op);
      if (outcome === 'retry') {
        useBoard.setState({ queueStalled: true });
        retryTimer = setTimeout(() => {
          retryTimer = null;
          flushQueue();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        return;
      }
      retryDelay = 1000;
      useBoard.setState((s) => ({
        pending: s.pending.filter((other) => other.id !== op.id),
        queueStalled: false,
      }));
    }
  } finally {
    flushing = false;
  }
}

async function sendOp(op) {
  const store = useBoard.getState();
  try {
    const result = await REQUESTS[op.kind](withVersions(op, store));
    useBoard.getState().applyResult(result);
    op.onDone?.(result);
    return 'done';
  } catch (err) {
    if (err.retryable) return 'retry';
    handleRejection(op, err);
    return 'dropped';
  }
}

/** The server refused. Removing the op from the queue is the rollback; this explains it. */
function handleRejection(op, err) {
  const store = useBoard.getState();
  const current = err.details?.current;
  if (current) store.applyResult(current.columnId ? { task: current } : { column: current });

  // A failed undo must not stay on the stack to fail again.
  if (op.fromHistory) {
    const remove = (entries) => entries.filter((entry) => entry.undo !== op.command && entry.redo !== op.command);
    useBoard.setState((s) => ({ past: remove(s.past), future: remove(s.future) }));
  }

  if (err.code === 'EDIT_CONFLICT' || err.code === 'MOVE_CONFLICT') {
    const who = nameOf(err.details?.conflicts?.[0]?.changedBy ?? err.details?.changedBy);
    if (op.fromHistory) {
      toast(`Can't ${op.fromHistory}: ${who} changed this afterwards.`, 'warning');
    } else if (err.code === 'MOVE_CONFLICT') {
      toast(`${who} moved “${current?.title ?? current?.name}” first, so it stays where they put it.`, 'warning');
    } else if (op.taskId) {
      useBoard.setState({
        conflict: { taskId: op.taskId, conflicts: err.details.conflicts, current },
      });
    } else {
      toast(`${who} renamed this first.`, 'warning');
    }
    return;
  }
  if (err.status === 404) {
    const what = op.kind.startsWith('column') ? 'column' : 'task';
    toast(`That ${what} no longer exists. Someone may have deleted it.`, 'warning');
    useBoard.getState().refresh();
    return;
  }
  toast(err.message, 'error');
}

// --- selectors ----------------------------------------------------------------

let lastInput = null;
let lastView = null;

/** The current view, memoized on the pieces it depends on. */
export function selectView(state) {
  if (
    lastInput &&
    lastInput.columns === state.columns &&
    lastInput.tasks === state.tasks &&
    lastInput.pending === state.pending &&
    lastInput.boardId === state.boardId
  ) {
    return lastView;
  }
  lastInput = state;
  lastView = computeView(state);
  return lastView;
}

export const useBoardView = () => useBoard(selectView);
