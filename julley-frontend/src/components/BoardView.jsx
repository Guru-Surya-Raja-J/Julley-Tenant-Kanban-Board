import { useMemo, useState } from 'react';
import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useBoard, useBoardView } from '../store/board.js';
import { usePresence, viewersByTask as groupViewers } from '../store/presence.js';
import { canAdminTenant, useRole, useSession } from '../store/session.js';
import { Column } from './Column.jsx';
import { TaskCardBody } from './TaskCard.jsx';
import { Dialog, Icon, NameForm } from './ui.jsx';

function collisionDetection(args) {
  const typeOf = (collision) => collision.data?.droppableContainer?.data.current?.type;
  if (args.active.data.current?.type === 'column') {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => c.data.current?.type === 'column'),
    });
  }
  const within = pointerWithin(args);
  const overTask = within.filter((c) => typeOf(c) === 'task');
  if (overTask.length) return overTask;
  if (within.length) return within;
  return closestCorners(args); // keyboard dragging has no pointer
}

/** Arrow keys on a column should go to the next column, not to the cards inside this one. */
function keyboardCoordinates(event, args) {
  const { context } = args;
  if (context.active?.data.current?.type !== 'column') return sortableKeyboardCoordinates(event, args);
  const containers = context.droppableContainers;
  return sortableKeyboardCoordinates(event, {
    ...args,
    context: {
      ...context,
      droppableContainers: {
        get: (id) => containers.get(id),
        getEnabled: () => containers.getEnabled().filter((c) => c.data.current?.type === 'column'),
      },
    },
  });
}

/** The columns as they should look mid-drag, computed over the live view. */
function withDrag(columns, drag) {
  if (!drag) return columns;
  if (drag.type === 'column') {
    if (drag.index === null) return columns;
    const rest = columns.filter((column) => column.id !== drag.id);
    const moving = columns.find((column) => column.id === drag.id);
    if (!moving) return columns;
    return [...rest.slice(0, drag.index), moving, ...rest.slice(drag.index)];
  }
  if (!drag.target) return columns;
  const task = columns.flatMap((column) => column.tasks).find((t) => t.id === drag.id);
  if (!task) return columns;
  return columns.map((column) => {
    const tasks = column.tasks.filter((t) => t.id !== drag.id);
    if (column.id === drag.target.columnId) tasks.splice(drag.target.index, 0, task);
    return tasks.length === column.tasks.length && column.id !== drag.target.columnId ? column : { ...column, tasks };
  });
}

function AddColumn() {
  const createColumn = useBoard((state) => state.createColumn);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="add-column" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} /> Add column
      </button>
      {open && (
        <Dialog title="New column" onClose={() => setOpen(false)} width={420}>
          <NameForm
            label="Column name"
            submitLabel="Add column"
            placeholder="e.g. In review"
            onCancel={() => setOpen(false)}
            onSubmit={async (name) => {
              createColumn(name);
              setOpen(false);
            }}
          />
        </Dialog>
      )}
    </>
  );
}

export function BoardView() {
  const status = useBoard((state) => state.status);
  const flash = useBoard((state) => state.flash);
  const moveTask = useBoard((state) => state.moveTask);
  const moveColumn = useBoard((state) => state.moveColumn);
  const openTask = useBoard((state) => state.openTask);
  const refresh = useBoard((state) => state.refresh);
  const view = useBoardView();
  const presence = usePresence((state) => state.entries);
  const me = useSession((state) => state.user);
  const memberList = useSession((state) => state.members);
  const role = useRole();
  const admin = canAdminTenant(role);
  const [drag, setDrag] = useState(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );

  const members = useMemo(() => Object.fromEntries(memberList.map((m) => [m.userId, m])), [memberList]);
  const viewersByTask = useMemo(() => groupViewers(presence, me?.id), [presence, me?.id]);
  const columns = useMemo(() => withDrag(view.columns, drag), [view.columns, drag]);

  if (status === 'loading' || status === 'idle') {
    return <div className="board-skeleton" aria-busy="true" aria-label="Loading board">{[0, 1, 2].map((i) => <div key={i} className="skeleton-column" />)}</div>;
  }
  if (status === 'error') {
    return (
      <div className="board-message">
        <h2>Couldn't load this board</h2>
        <p>Check your connection. It will retry when you're back online.</p>
        <button type="button" className="button" onClick={refresh}>Try again</button>
      </div>
    );
  }

  const handleDragStart = ({ active }) => {
    setDrag(active.data.current?.type === 'column'
      ? { type: 'column', id: active.id, index: null }
      : { type: 'task', id: active.id, target: null });
  };

  // Also runs on every move: above-or-below changes while hovering a single card.
  const handleDragOver = ({ active, over }) => {
    if (!over || !drag) return;
    const overData = over.data.current;

    if (drag.type === 'column') {
      if (overData?.type !== 'column') return;
      const others = view.columns.filter((column) => column.id !== active.id);
      const index = others.findIndex((column) => column.id === over.id);
      if (index < 0) return;
      const overIndex = columns.findIndex((column) => column.id === over.id);
      const activeIndex = columns.findIndex((column) => column.id === active.id);
      const next = activeIndex < overIndex ? index + 1 : index;
      if (next !== drag.index) setDrag({ ...drag, index: next });
      return;
    }

    if (over.id === active.id) return;
    let target;
    if (overData?.type === 'column') {
      const column = columns.find((c) => c.id === over.id);
      if (!column) return;
      // Over the column but not a card: the end of the list, unless already in it.
      if (drag.target?.columnId === over.id) return;
      target = { columnId: over.id, index: column.tasks.filter((t) => t.id !== active.id).length };
    } else if (overData?.type === 'task') {
      const column = columns.find((c) => c.id === overData.columnId);
      if (!column) return;
      const siblings = column.tasks.filter((t) => t.id !== active.id);
      const index = siblings.findIndex((t) => t.id === over.id);
      if (index < 0) return;
      const moving = active.rect.current.translated;
      const below = moving && moving.top + moving.height / 2 > over.rect.top + over.rect.height / 2;
      target = { columnId: overData.columnId, index: below ? index + 1 : index };
    }
    if (target && (target.columnId !== drag.target?.columnId || target.index !== drag.target?.index)) {
      setDrag({ ...drag, target });
    }
  };

  const handleDragEnd = () => {
    const finished = drag;
    setDrag(null);
    if (!finished) return;

    if (finished.type === 'column') {
      if (finished.index === null) return;
      const index = columns.findIndex((column) => column.id === finished.id);
      const before = view.columns.findIndex((column) => column.id === finished.id);
      if (index < 0 || index === before) return;
      moveColumn(finished.id, columns[index - 1]?.id ?? null, columns[index + 1]?.id ?? null);
      return;
    }

    if (!finished.target) return;
    // The card may have been deleted by a colleague during the drag.
    if (!view.tasksById[finished.id]) return;
    const column = columns.find((c) => c.id === finished.target.columnId);
    if (!column) return;
    const index = column.tasks.findIndex((t) => t.id === finished.id);
    if (index < 0) return;
    const original = view.columns.find((c) => c.id === finished.target.columnId);
    const unmoved = original?.tasks.findIndex((t) => t.id === finished.id) === index;
    if (unmoved) return;
    moveTask(finished.id, column.id, column.tasks[index - 1]?.id ?? null, column.tasks[index + 1]?.id ?? null);
  };

  const activeTask = drag?.type === 'task' ? view.tasksById[drag.id] : null;
  const activeColumn = drag?.type === 'column' ? view.columns.find((c) => c.id === drag.id) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragMove={handleDragOver}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDrag(null)}
    >
      <div className="board" data-testid="board">
        <SortableContext items={columns.map((column) => column.id)} strategy={drag?.type === 'column' ? () => null : horizontalListSortingStrategy}>
          {columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              tasks={column.tasks}
              admin={admin}
              members={members}
              viewersByTask={viewersByTask}
              pendingIds={view.pendingIds}
              flash={flash}
              onOpenTask={openTask}
            />
          ))}
        </SortableContext>
        {admin && <AddColumn />}
        {!columns.length && !admin && <p className="board-empty">This board has no columns yet.</p>}
      </div>

      <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
        {activeTask && <TaskCardBody task={activeTask} assignee={members[activeTask.assigneeId]} overlay />}
        {activeColumn && (
          <div className="column column-overlay">
            <header className="column-head"><h3 className="column-name">{activeColumn.name}</h3></header>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
