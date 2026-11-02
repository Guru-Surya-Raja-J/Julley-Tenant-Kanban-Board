import { useBoard } from '../store/board.js';
import { useSession } from '../store/session.js';

/** Tells the truth about sync: live, saving, or offline with changes waiting. */
export function SyncStatus() {
  const connection = useSession((state) => state.connection);
  const pendingCount = useBoard((state) => state.pending.length);
  const stalled = useBoard((state) => state.queueStalled);

  let tone = 'live';
  let label = 'Live';
  if (stalled) {
    tone = 'offline';
    label = `Offline, ${pendingCount} waiting`;
  } else if (connection === 'reconnecting' || connection === 'closed') {
    tone = 'offline';
    label = pendingCount ? `Reconnecting, ${pendingCount} waiting` : 'Reconnecting';
  } else if (connection === 'connecting') {
    tone = 'busy';
    label = 'Connecting';
  } else if (pendingCount) {
    tone = 'busy';
    label = 'Saving';
  }

  return (
    <span className={`sync sync-${tone}`} role="status" data-testid="sync-status">
      <span className="sync-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
