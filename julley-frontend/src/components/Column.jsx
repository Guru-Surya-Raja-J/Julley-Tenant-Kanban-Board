import { useRef, useState } from 'react';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useBoard } from '../store/board.js';
import { TaskCard } from './TaskCard.jsx';
import { Icon, MenuItem, Popover } from './ui.jsx';

// Items are reordered in state while dragging, so the library needn't shift them too.
const noShift = () => null;

function ColumnName({ column, admin }) {
  const renameColumn = useBoard((state) => state.renameColumn);
  const [draft, setDraft] = useState(null);
  const base = useRef(column.version);

  if (!admin) return <h3 className="column-name">{column.name}</h3>;
  if (draft === null) {
    return (
      <h3 className="column-name">
        <button
          type="button"
          className="column-name-button"
          title="Rename column"
          onClick={() => {
            base.current = column.version;
            setDraft(column.name);
          }}
          // The header is a drag handle. A click on the name should only rename.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          {column.name}
        </button>
      </h3>
    );
  }
  const commit = () => {
    const name = draft.trim();
    setDraft(null);
    if (name && name !== column.name) renameColumn(column.id, name, base.current);
  };
  return (
    <input
      className="column-name-input"
      autoFocus
      value={draft}
      maxLength={120}
      aria-label="Column name"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(null);
      }}
    />
  );
}

function AddTask({ columnId }) {
  const createTask = useBoard((state) => state.createTask);
  const [draft, setDraft] = useState(null);

  if (draft === null) {
    return (
      <button type="button" className="add-task" onClick={() => setDraft('')}>
        <Icon name="plus" size={14} /> Add task
      </button>
    );
  }
  return (
    <form
      className="add-task-form"
      onSubmit={(event) => {
        event.preventDefault();
        const title = draft.trim();
        if (title) createTask(columnId, title);
        setDraft('');
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={draft}
        maxLength={300}
        placeholder="What needs doing?"
        aria-label="New task title"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const title = draft.trim();
          if (title) createTask(columnId, title);
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form.requestSubmit();
          }
          if (event.key === 'Escape') setDraft(null);
        }}
      />
    </form>
  );
}

export function Column({ column, tasks, admin, members, viewersByTask, pendingIds, flash, onOpenTask }) {
  const deleteColumn = useBoard((state) => state.deleteColumn);
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: column.id,
    data: { type: 'column' },
    disabled: { draggable: !admin, droppable: false },
    animateLayoutChanges: () => true,
  });

  // The mouse can drag from anywhere on the header. The keyboard uses the grip, so
  // the header itself isn't a button with other buttons inside it.
  const { onKeyDown, ...pointerListeners } = listeners ?? {};

  return (
    <section
      ref={setNodeRef}
      className={`column${isDragging ? ' is-dragging' : ''}${flash[column.id] ? ' column-flash' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition, '--flash': flash[column.id] }}
      data-testid="column"
      aria-label={column.name}
    >
      <header className={`column-head${admin ? ' is-draggable' : ''}`} {...(admin ? pointerListeners : {})}>
        {admin && (
          <button
            type="button"
            className="column-grip"
            ref={setActivatorNodeRef}
            aria-label={`Move ${column.name} column`}
            aria-roledescription={attributes['aria-roledescription']}
            aria-describedby={attributes['aria-describedby']}
            onKeyDown={onKeyDown}
          >
            <Icon name="grip" size={14} />
          </button>
        )}
        <ColumnName column={column} admin={admin} />
        <span className="column-count" aria-label={`${tasks.length} tasks`}>{tasks.length}</span>
        {admin && (
          <span
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Popover align="end" className="column-menu" label={`${column.name} column options`} trigger={<Icon name="dots" />}>
              {(close) => (
                <div className="menu">
                  <MenuItem
                    danger
                    onClick={() => {
                      close();
                      deleteColumn(column.id);
                    }}
                  >
                    <Icon name="trash" size={14} /> Delete column
                  </MenuItem>
                </div>
              )}
            </Popover>
          </span>
        )}
      </header>

      <SortableContext items={tasks.map((task) => task.id)} strategy={noShift}>
        <div className="column-tasks">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              columnId={column.id}
              assignee={members[task.assigneeId]}
              viewers={viewersByTask[task.id]}
              pending={pendingIds.has(task.id)}
              flash={flash[task.id]}
              onOpen={onOpenTask}
            />
          ))}
          {!tasks.length && <p className="column-empty">Nothing here</p>}
        </div>
      </SortableContext>
      <AddTask columnId={column.id} />
    </section>
  );
}
