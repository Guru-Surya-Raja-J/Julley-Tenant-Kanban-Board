import { generateKeyBetween } from 'fractional-indexing';

// The screen is a pure function of confirmed server state plus pending operations.
// Rolling back an operation is therefore just removing it from the list.

/** Bytewise, matching COLLATE "C" on the server. localeCompare would disagree. */
export function byPosition(a, b) {
  if (a.position === b.position) return a.id < b.id ? -1 : 1;
  return a.position < b.position ? -1 : 1;
}

/** A local rank key for a placement intent, using the same fallbacks as the server. */
export function placeAmong(sorted, { afterId, beforeId }) {
  try {
    const afterIndex = afterId ? sorted.findIndex((item) => item.id === afterId) : -1;
    if (afterIndex >= 0) {
      return generateKeyBetween(sorted[afterIndex].position, sorted[afterIndex + 1]?.position ?? null);
    }
    const beforeIndex = beforeId ? sorted.findIndex((item) => item.id === beforeId) : -1;
    if (beforeIndex >= 0) {
      return generateKeyBetween(sorted[beforeIndex - 1]?.position ?? null, sorted[beforeIndex].position);
    }
    return generateKeyBetween(sorted.at(-1)?.position ?? null, null);
  } catch {
    // Two items share a key mid-flight. A moment of wrong order beats a crash.
    return `${sorted.at(-1)?.position ?? 'a0'}V`;
  }
}

const liveTasksIn = (tasks, columnId, exceptId) =>
  Object.values(tasks)
    .filter((task) => task.columnId === columnId && task.id !== exceptId)
    .sort(byPosition);

const liveColumnsExcept = (columns, exceptId) =>
  Object.values(columns)
    .filter((column) => column.id !== exceptId)
    .sort(byPosition);

function omit(map, key) {
  const copy = { ...map };
  delete copy[key];
  return copy;
}

const APPLY = {
  'task.create': (state, cmd) => {
    const position = placeAmong(liveTasksIn(state.tasks, cmd.task.columnId), cmd);
    state.tasks = { ...state.tasks, [cmd.task.id]: { ...cmd.task, position } };
    state.pendingIds.add(cmd.task.id);
  },
  'task.update': (state, cmd) => {
    const task = state.tasks[cmd.taskId];
    if (!task) return;
    state.tasks = { ...state.tasks, [cmd.taskId]: { ...task, ...cmd.patch } };
    state.pendingIds.add(cmd.taskId);
  },
  'task.move': (state, cmd) => {
    const task = state.tasks[cmd.taskId];
    if (!task) return;
    const position = placeAmong(liveTasksIn(state.tasks, cmd.columnId, cmd.taskId), cmd);
    state.tasks = { ...state.tasks, [cmd.taskId]: { ...task, columnId: cmd.columnId, position } };
    state.pendingIds.add(cmd.taskId);
  },
  'task.delete': (state, cmd) => {
    state.tasks = omit(state.tasks, cmd.taskId);
  },
  'task.restore': (state, cmd) => {
    const position = placeAmong(liveTasksIn(state.tasks, cmd.columnId, cmd.taskId), cmd);
    state.tasks = { ...state.tasks, [cmd.taskId]: { ...cmd.snapshot, columnId: cmd.columnId, position } };
    state.pendingIds.add(cmd.taskId);
  },
  'column.create': (state, cmd) => {
    const position = placeAmong(liveColumnsExcept(state.columns), cmd);
    state.columns = { ...state.columns, [cmd.column.id]: { ...cmd.column, position } };
    state.pendingIds.add(cmd.column.id);
  },
  'column.update': (state, cmd) => {
    const column = state.columns[cmd.columnId];
    if (!column) return;
    state.columns = { ...state.columns, [cmd.columnId]: { ...column, ...cmd.patch } };
    state.pendingIds.add(cmd.columnId);
  },
  'column.move': (state, cmd) => {
    const column = state.columns[cmd.columnId];
    if (!column) return;
    const position = placeAmong(liveColumnsExcept(state.columns, cmd.columnId), cmd);
    state.columns = { ...state.columns, [cmd.columnId]: { ...column, position } };
    state.pendingIds.add(cmd.columnId);
  },
  'column.delete': (state, cmd) => {
    state.columns = omit(state.columns, cmd.columnId);
  },
  'column.restore': (state, cmd) => {
    const position = placeAmong(liveColumnsExcept(state.columns, cmd.columnId), cmd);
    state.columns = { ...state.columns, [cmd.columnId]: { ...cmd.snapshot, position } };
    state.pendingIds.add(cmd.columnId);
  },
};

/** Replays pending operations over server state and groups the result for display. */
export function computeView({ boardId, columns, tasks, pending }) {
  const state = { columns, tasks, pendingIds: new Set() };
  for (const op of pending) {
    if (op.boardId === boardId) APPLY[op.kind]?.(state, op);
  }

  const grouped = Object.fromEntries(Object.keys(state.columns).map((id) => [id, []]));
  for (const task of Object.values(state.tasks)) grouped[task.columnId]?.push(task);

  return {
    tasksById: state.tasks,
    pendingIds: state.pendingIds,
    columns: Object.values(state.columns)
      .sort(byPosition)
      .map((column) => ({ ...column, tasks: grouped[column.id].sort(byPosition) })),
  };
}

/** The neighbours of an item in a list, as a placement intent that would restore it. */
export function neighboursOf(list, id) {
  const index = list.findIndex((item) => item.id === id);
  return { afterId: list[index - 1]?.id ?? null, beforeId: list[index + 1]?.id ?? null };
}

/** Whether an event's entity should replace what we hold. */
export function isNewer(incoming, existing, { strict = false } = {}) {
  if (!existing) return true;
  return strict ? incoming.version > existing.version : incoming.version >= existing.version;
}
