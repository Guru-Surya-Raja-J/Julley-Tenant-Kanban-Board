import { ROLE_LABELS } from './format.js';

const FIELD_NAMES = { title: 'title', description: 'description', priority: 'priority', assigneeId: 'assignee', dueDate: 'due date', name: 'name' };

const list = (items) => {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
};

/** A plain-language sentence for an event, to follow the actor's name. */
export function describeEvent(event, columns = []) {
  const { action, payload } = event;
  const columnName = (id) => columns.find((column) => column.id === id)?.name;
  const taskName = payload.task ? `“${payload.task.title}”` : '';

  switch (action) {
    case 'task.created':
      return `added ${taskName}`;
    case 'task.updated': {
      const fields = Object.keys(payload.changes ?? {}).map((field) => FIELD_NAMES[field] ?? field);
      if (payload.changes?.title) {
        return `renamed “${payload.changes.title.from}” to ${taskName}`;
      }
      return `changed the ${list(fields)} of ${taskName}`;
    }
    case 'task.moved': {
      const to = columnName(payload.to?.columnId);
      if (payload.from?.columnId === payload.to?.columnId) return `reordered ${taskName}`;
      return to ? `moved ${taskName} to ${to}` : `moved ${taskName}`;
    }
    case 'task.deleted':
      return `deleted ${taskName}`;
    case 'task.restored':
      return `restored ${taskName}`;
    case 'column.created':
      return `added the column “${payload.column.name}”`;
    case 'column.updated':
      return `renamed a column to “${payload.column.name}”`;
    case 'column.moved':
      return `moved the column “${payload.column.name}”`;
    case 'column.deleted':
      return `deleted the column “${payload.column.name}”`;
    case 'column.restored':
      return `restored the column “${payload.column.name}”`;
    case 'column.rebalanced':
    case 'board.rebalanced':
      return 'tidied up card ordering';
    case 'board.created':
      return `created the board “${payload.board.name}”`;
    case 'board.updated':
      return `updated the board “${payload.board.name}”`;
    case 'board.deleted':
      return `deleted the board “${payload.board.name}”`;
    case 'tenant.created':
      return `created this branch`;
    case 'tenant.updated':
      return `renamed this branch to “${payload.tenant.name}”`;
    case 'member.added':
      return `added ${payload.member.name} as ${ROLE_LABELS[payload.member.role]}`;
    case 'member.updated':
      return `made ${payload.member.name} ${ROLE_LABELS[payload.member.role]}`;
    case 'member.removed':
      return `removed ${payload.member.name}`;
    default:
      return action;
  }
}
