import { useActivity } from '../store/activity.js';
import { useBoardView } from '../store/board.js';
import { describeEvent } from '../lib/describeEvent.js';
import { timeAgo } from '../lib/format.js';
import { Avatar, Icon } from './ui.jsx';

export function ActivityDrawer({ onClose }) {
  const events = useActivity((state) => state.events);
  const loading = useActivity((state) => state.loading);
  const hasMore = useActivity((state) => state.nextBeforeSeq !== null);
  const loadMore = useActivity((state) => state.loadMore);
  const view = useBoardView();
  const visible = events.filter((event) => !event.action.endsWith('.rebalanced'));

  return (
    <aside className="panel activity" aria-label="Activity" data-testid="activity">
      <header className="panel-head">
        <h2>Activity</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close activity">
          <Icon name="close" />
        </button>
      </header>
      <div className="panel-body">
        {!visible.length && !loading && <p className="muted">Nothing has happened in this branch yet. Changes will appear here as they happen.</p>}
        <ol className="activity-list">
          {visible.map((event) => (
            <li key={event.seq}>
              <Avatar name={event.actor?.name ?? 'Former user'} color={event.actor?.color} size="sm" />
              <div>
                <p>
                  <strong>{event.actor?.name ?? 'Former user'}</strong> {describeEvent(event, view.columns)}
                </p>
                <small>
                  {timeAgo(event.at)} <span className="mono">#{event.seq}</span>
                </small>
              </div>
            </li>
          ))}
        </ol>
        {hasMore && (
          <button type="button" className="button button-wide" disabled={loading} onClick={loadMore}>
            Load earlier
          </button>
        )}
      </div>
    </aside>
  );
}
