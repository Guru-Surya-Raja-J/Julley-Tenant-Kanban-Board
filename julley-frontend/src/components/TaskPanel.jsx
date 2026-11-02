import { useEffect, useRef, useState } from 'react';
import { useActivity } from '../store/activity.js';
import { useBoard, useBoardView } from '../store/board.js';
import { usePresence } from '../store/presence.js';
import { useSession } from '../store/session.js';
import { describeEvent } from '../lib/describeEvent.js';
import { timeAgo } from '../lib/format.js';
import { Avatar, Icon } from './ui.jsx';

const PRIORITIES = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['urgent', 'Urgent'],
];

/**
 * A text field that edits a draft. While focused, a colleague's change can't
 * overwrite what you are typing; the version you started from goes with your save,
 * which is how the server detects a real conflict.
 */
function EditableText({ value, version, onCommit, multiline, label, placeholder, required, maxLength }) {
  const [draft, setDraft] = useState(null);
  const base = useRef(version);
  const Element = multiline ? 'textarea' : 'input';

  return (
    <Element
      className={multiline ? 'panel-description' : 'panel-title'}
      aria-label={label}
      placeholder={placeholder}
      maxLength={maxLength}
      rows={multiline ? 6 : undefined}
      value={draft ?? value}
      onFocus={() => {
        base.current = version;
        setDraft(value);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft === null ? value : multiline ? draft : draft.trim();
        setDraft(null);
        if (next === value || (required && !next)) return;
        onCommit(next, base.current);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setDraft(null);
          event.currentTarget.blur();
        }
        if (!multiline && event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

export function TaskPanel() {
  const taskId = useBoard((state) => state.openTaskId);
  const openTask = useBoard((state) => state.openTask);
  const updateTask = useBoard((state) => state.updateTask);
  const deleteTask = useBoard((state) => state.deleteTask);
  const view = useBoardView();
  const members = useSession((state) => state.members);
  const me = useSession((state) => state.user);
  const presence = usePresence((state) => state.entries);
  const events = useActivity((state) => state.events);
  const panel = useRef(null);

  const task = taskId ? view.tasksById[taskId] : null;
  const column = task && view.columns.find((c) => c.id === task.columnId);

  useEffect(() => {
    // Opened on a task that has since gone, or whose column was just deleted.
    if (taskId && !column) openTask(null);
  }, [taskId, column, openTask]);

  useEffect(() => {
    if (!taskId) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !event.target.closest('dialog')) openTask(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [taskId, openTask]);

  if (!task || !column) return null;

  const viewers = [];
  const seen = new Set();
  for (const entry of presence) {
    if (entry.taskId === task.id && entry.userId !== me?.id && !seen.has(entry.userId)) {
      seen.add(entry.userId);
      viewers.push(entry);
    }
  }
  const history = events.filter((event) => event.entityId === task.id).slice(0, 8);
  const commit = (field) => (value, base) => updateTask(task.id, { [field]: value }, base);

  return (
    <aside className="panel" ref={panel} aria-label="Task details" data-testid="task-panel">
      <header className="panel-head">
        <span className="panel-column">{column.name}</span>
        <div className="panel-head-actions">
          {viewers.map((viewer) => (
            <span key={viewer.userId} className="panel-viewer" title={`${viewer.name} has this open too`}>
              <Avatar name={viewer.name} color={viewer.color} size="sm" ring />
            </span>
          ))}
          <button type="button" className="icon-button" onClick={() => deleteTask(task.id)} aria-label="Delete task" title="Delete task">
            <Icon name="trash" />
          </button>
          <button type="button" className="icon-button" onClick={() => openTask(null)} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
      </header>

      <div className="panel-body">
        <EditableText
          key={`${task.id}-title`}
          label="Title"
          required
          maxLength={300}
          value={task.title}
          version={task.version}
          onCommit={commit('title')}
        />

        <dl className="panel-fields">
          <div>
            <dt><label htmlFor="panel-priority">Priority</label></dt>
            <dd>
              <select id="panel-priority" value={task.priority} onChange={(event) => commit('priority')(event.target.value, task.version)}>
                {PRIORITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </dd>
          </div>
          <div>
            <dt><label htmlFor="panel-assignee">Assignee</label></dt>
            <dd>
              <select id="panel-assignee" value={task.assigneeId ?? ''} onChange={(event) => commit('assigneeId')(event.target.value || null, task.version)}>
                <option value="">Unassigned</option>
                {members.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}
                {task.assigneeId && !members.some((m) => m.userId === task.assigneeId) && (
                  <option value={task.assigneeId}>Former member</option>
                )}
              </select>
            </dd>
          </div>
          <div>
            <dt><label htmlFor="panel-due">Due date</label></dt>
            <dd>
              <input id="panel-due" type="date" value={task.dueDate ?? ''} onChange={(event) => commit('dueDate')(event.target.value || null, task.version)} />
            </dd>
          </div>
        </dl>

        <section className="panel-section">
          <h3>Description</h3>
          <EditableText
            key={`${task.id}-description`}
            label="Description"
            multiline
            maxLength={20000}
            placeholder="Add details, links, acceptance criteria…"
            value={task.description}
            version={task.version}
            onCommit={commit('description')}
          />
        </section>

        {history.length > 0 && (
          <section className="panel-section">
            <h3>Recent activity</h3>
            <ul className="panel-history">
              {history.map((event) => (
                <li key={event.seq}>
                  <Avatar name={event.actor?.name ?? 'Former user'} color={event.actor?.color} size="xs" />
                  <span>
                    <strong>{event.actor?.name ?? 'Former user'}</strong> {describeEvent(event, view.columns)}
                    <small> {timeAgo(event.at)}</small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
