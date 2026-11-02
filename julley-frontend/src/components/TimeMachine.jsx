import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { describeEvent } from '../lib/describeEvent.js';
import { timeAgo } from '../lib/format.js';
import { buildFrames } from '../lib/replay.js';
import { computeView } from '../lib/view.js';
import { useSession } from '../store/session.js';
import { TaskCardBody } from './TaskCard.jsx';
import { Avatar, Icon } from './ui.jsx';

const PLAY_INTERVAL_MS = 900;

async function fetchAllEvents(tenantId, boardId) {
  const events = [];
  let after = 0;
  while (after !== null) {
    const page = await api.get(`/tenants/${tenantId}/boards/${boardId}/history?afterSeq=${after}&limit=500`);
    events.push(...page.events);
    after = page.nextAfterSeq;
  }
  return events;
}

/** Replays a board from its event log. Read-only, and nothing here touches live state. */
export function TimeMachine({ onClose }) {
  const tenantId = useSession((state) => state.tenantId);
  const boardId = useSession((state) => state.boardId);
  const memberList = useSession((state) => state.members);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let active = true;
    fetchAllEvents(tenantId, boardId).then(
      (loaded) => {
        if (!active) return;
        setEvents(loaded);
        setPosition(loaded.length);
      },
      (err) => {
        if (active) setError(err.message);
      },
    );
    return () => {
      active = false;
    };
  }, [tenantId, boardId]);

  const frames = useMemo(() => buildFrames(events ?? []), [events]);
  const total = events?.length ?? 0;

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      setPosition((current) => {
        if (current >= total) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, total]);

  const frame = frames[position] ?? frames[0];
  const view = useMemo(
    () => computeView({ boardId, columns: frame.columns, tasks: frame.tasks, pending: [] }),
    [boardId, frame],
  );
  const members = useMemo(() => Object.fromEntries(memberList.map((m) => [m.userId, m])), [memberList]);
  const current = position > 0 ? events?.[position - 1] : null;
  const startsWithBoard = events?.[0]?.action === 'board.created';

  const togglePlay = () => {
    if (!playing && position >= total) setPosition(0);
    setPlaying(!playing);
  };

  return (
    <div className="time-machine" data-testid="time-machine">
      <div className="tm-bar">
        <div className="tm-title">
          <Icon name="clock" />
          <div>
            <strong>Time Machine</strong>
            <small>Rebuilt from this board's event log. Read-only.</small>
          </div>
          <button type="button" className="button tm-exit" onClick={onClose}>Back to live</button>
        </div>
        {events && total > 0 && (
          <div className="tm-controls">
            <button type="button" className="icon-button" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
              <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Previous event"
              disabled={position === 0}
              onClick={() => {
                setPlaying(false);
                setPosition(position - 1);
              }}
            >
              <Icon name="undo" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Next event"
              disabled={position === total}
              onClick={() => {
                setPlaying(false);
                setPosition(position + 1);
              }}
            >
              <Icon name="redo" />
            </button>
            <input
              className="tm-range"
              type="range"
              min={0}
              max={total}
              value={position}
              aria-label="Point in the board's history"
              onChange={(event) => {
                setPlaying(false);
                setPosition(Number(event.target.value));
              }}
            />
            <span className="tm-count mono" data-testid="tm-count">{position} / {total}</span>
          </div>
        )}
        <p className="tm-caption" data-testid="tm-caption" aria-live="polite">
          {current ? (
            <>
              <Avatar name={current.actor?.name ?? 'Former user'} color={current.actor?.color} size="xs" />
              <span>
                <strong>{current.actor?.name ?? 'Former user'}</strong> {describeEvent(current, Object.values(frame.columns))}
                <small> {timeAgo(current.at)} <span className="mono">#{current.seq}</span></small>
              </span>
            </>
          ) : (
            events && total > 0 && <span className="muted">Before this board existed.</span>
          )}
        </p>
      </div>

      {error && <div className="board-message"><h2>Couldn't load the history</h2><p>{error}</p></div>}
      {!error && !events && <div className="board-message" aria-busy="true"><p>Loading history…</p></div>}
      {events && (total === 0 || !startsWithBoard) && (
        <div className="board-message">
          <h2>This board's history is incomplete</h2>
          <p>It was created before event logging covered it, so its early state can't be rebuilt.</p>
        </div>
      )}
      {events && startsWithBoard && (
        <div className="board board-replay">
          {view.columns.map((column) => (
            <section key={column.id} className="column" aria-label={column.name}>
              <header className="column-head">
                <h3 className="column-name">{column.name}</h3>
                <span className="column-count">{column.tasks.length}</span>
              </header>
              <div className="column-tasks">
                {column.tasks.map((task) => {
                  const changed = current?.entityId === task.id;
                  return (
                    <TaskCardBody
                      key={changed ? `${task.id}-${position}` : task.id}
                      task={task}
                      assignee={members[task.assigneeId]}
                      flash={changed ? (current.actor?.color ?? 'var(--signal)') : undefined}
                    />
                  );
                })}
                {!column.tasks.length && <p className="column-empty">Nothing here</p>}
              </div>
            </section>
          ))}
          {position === 0 && <p className="board-empty">Drag the slider or press play to watch this board being built.</p>}
        </div>
      )}
    </div>
  );
}
