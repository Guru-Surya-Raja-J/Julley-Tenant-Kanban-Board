import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Avatar, Icon } from './ui.jsx';

function dueState(dueDate) {
  if (!dueDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  return 'later';
}

function formatDue(dueDate) {
  const [year, month, day] = dueDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The visual card, shared by the board and the drag overlay. */
export const TaskCardBody = memo(function TaskCardBody({ task, assignee, viewers, pending, flash, overlay }) {
  const due = dueState(task.dueDate);
  const flagged = task.priority === 'urgent' || task.priority === 'high';
  const hasMeta = flagged || due || assignee || viewers?.length;
  return (
    <article
      className={`card priority-${task.priority}${overlay ? ' card-overlay' : ''}${flash ? ' card-flash' : ''}`}
      style={flash ? { '--flash': flash } : undefined}
      data-testid="task-card"
      data-pending={pending || undefined}
    >
      <h4 className="card-title">{task.title}</h4>
      {hasMeta ? (
        <div className="card-meta">
          {flagged && (
            <span className={`tag tag-${task.priority}`}>{task.priority === 'urgent' ? 'Urgent' : 'High'}</span>
          )}
          {due && (
            <span className={`due due-${due}`}>
              <Icon name="calendar" size={12} />
              {formatDue(task.dueDate)}
            </span>
          )}
          <span className="card-meta-end">
            {viewers?.map((viewer) => (
              <span key={viewer.userId} className="card-viewer" data-testid="card-viewer">
                <Avatar name={viewer.name} color={viewer.color} size="xs" title={`${viewer.name} has this open`} ring />
              </span>
            ))}
            {assignee && <Avatar name={assignee.name} color={assignee.color} size="sm" title={`Assigned to ${assignee.name}`} />}
          </span>
        </div>
      ) : null}
      {pending && <span className="card-pending" title="Saving" aria-label="Saving" />}
    </article>
  );
});

export function TaskCard({ task, columnId, assignee, viewers, pending, flash, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', columnId },
    animateLayoutChanges: () => true,
  });

  return (
    <div
      ref={setNodeRef}
      className={`card-slot${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={() => onOpen(task.id)}
      onKeyDown={(event) => {
        // Space starts a keyboard drag; Enter opens the card.
        if (event.key === 'Enter') onOpen(task.id);
      }}
      {...attributes}
      {...listeners}
      aria-roledescription="Draggable task"
    >
      <TaskCardBody task={task} assignee={assignee} viewers={viewers} pending={pending} flash={flash} />
    </div>
  );
}
