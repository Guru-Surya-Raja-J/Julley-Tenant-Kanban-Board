// Rebuilds a board from its event log. Events carry full entities, so each frame is
// a small immutable step from the previous one, and scrubbing never refetches.

const toMap = (items) => Object.fromEntries(items.map((item) => [item.id, item]));

function without(map, id) {
  const copy = { ...map };
  delete copy[id];
  return copy;
}

function withPositions(map, positions) {
  const copy = { ...map };
  for (const [id, position] of Object.entries(positions)) {
    if (copy[id]) copy[id] = { ...copy[id], position };
  }
  return copy;
}

export const EMPTY_FRAME = { board: null, columns: {}, tasks: {} };

export function applyToFrame(frame, { action, payload }) {
  switch (action) {
    case 'board.created':
      return { ...frame, board: payload.board, columns: toMap(payload.columns) };
    case 'board.updated':
      return { ...frame, board: payload.board };
    case 'board.rebalanced':
      return { ...frame, columns: withPositions(frame.columns, payload.positions) };
    case 'column.created':
    case 'column.updated':
    case 'column.moved':
      return { ...frame, columns: { ...frame.columns, [payload.column.id]: payload.column } };
    case 'column.deleted':
      // Its tasks stay in the frame: they return if the column is restored.
      return { ...frame, columns: without(frame.columns, payload.column.id) };
    case 'column.restored':
      return {
        ...frame,
        columns: { ...frame.columns, [payload.column.id]: payload.column },
        tasks: { ...frame.tasks, ...toMap(payload.tasks) },
      };
    case 'column.rebalanced':
      return { ...frame, tasks: withPositions(frame.tasks, payload.positions) };
    case 'task.created':
    case 'task.updated':
    case 'task.moved':
    case 'task.restored':
      return { ...frame, tasks: { ...frame.tasks, [payload.task.id]: payload.task } };
    case 'task.deleted':
      return { ...frame, tasks: without(frame.tasks, payload.task.id) };
    default:
      return frame;
  }
}

/** frames[0] is empty, and frames[n] is the board after the first n events. */
export function buildFrames(events) {
  const frames = [EMPTY_FRAME];
  for (const event of events) frames.push(applyToFrame(frames.at(-1), event));
  return frames;
}

/** Tasks visible in a frame, excluding those inside a deleted column. */
export function visibleTasks(frame) {
  return Object.values(frame.tasks).filter((task) => frame.columns[task.columnId]);
}
