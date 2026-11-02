import { useBoard } from '../store/board.js';
import { useSession } from '../store/session.js';
import { Dialog } from './ui.jsx';

const FIELD_NAMES = { title: 'Title', description: 'Description', priority: 'Priority', assigneeId: 'Assignee', dueDate: 'Due date' };

export function ConflictDialog() {
  const conflict = useBoard((state) => state.conflict);
  const resolveConflict = useBoard((state) => state.resolveConflict);
  const members = useSession((state) => state.members);
  if (!conflict) return null;

  const nameOf = (id) => members.find((m) => m.userId === id)?.name ?? 'Someone';
  const display = (field, value) => {
    if (value === null || value === undefined || value === '') return 'Empty';
    return field === 'assigneeId' ? nameOf(value) : String(value);
  };
  const who = nameOf(conflict.conflicts[0].changedBy);

  return (
    <Dialog title={`${who} changed this while you were editing`} onClose={() => resolveConflict('theirs')}>
      <p className="muted">Both of you edited “{conflict.current.title}”. Their change is saved. Choose which version to keep.</p>
      <div className="conflict-list" data-testid="conflict-dialog">
        {conflict.conflicts.map(({ field, yours, theirs }) => (
          <div className="conflict-field" key={field}>
            <h3>{FIELD_NAMES[field] ?? field}</h3>
            <div className="conflict-values">
              <div>
                <small>{who}'s version</small>
                <p>{display(field, theirs)}</p>
              </div>
              <div>
                <small>Your version</small>
                <p>{display(field, yours)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="form-actions">
        <button type="button" className="button" onClick={() => resolveConflict('theirs')}>Use {who}'s</button>
        <button type="button" className="button button-primary" onClick={() => resolveConflict('mine')}>Keep mine</button>
      </div>
    </Dialog>
  );
}
