import { useEffect, useState } from 'react';

// A scripted illustration of how the system behaves, not live data. Each frame is
// the full state of the two windows, and CSS animates the cards between frames.

const CARDS = { a: 'Audit labels', b: 'Pilot aisle 12', c: 'Train leads', d: 'New scanners' };
const COLUMNS = ['To do', 'Doing', 'Done'];

const place = (todo = [], doing = [], done = []) => ({ todo, doing, done });

const SCENES = [
  {
    id: 'sync',
    label: 'Live sync',
    caption: 'A move shows instantly for the person who made it, then reaches everyone else in the branch.',
    frames: [
      { ben: place(['a', 'b', 'c']), cara: place(['a', 'b', 'c']) },
      { ben: place(['a', 'c'], ['b']), cara: place(['a', 'b', 'c']), pendingBen: 'b' },
      { ben: place(['a', 'c'], ['b']), cara: place(['a', 'b', 'c']), wire: 'right', log: ['#41', 'task.moved', 'Ben'] },
      { ben: place(['a', 'c'], ['b']), cara: place(['a', 'c'], ['b']), flashCara: 'b', log: ['#41', 'task.moved', 'Ben'] },
    ],
  },
  {
    id: 'conflict',
    label: 'Conflict',
    caption: 'Two people drag one card. The first write wins, and the other card returns with an explanation.',
    frames: [
      { ben: place(['a', 'c'], ['b']), cara: place(['a', 'c'], ['b']) },
      { ben: place(['c'], ['b', 'a']), cara: place(['c'], ['b'], ['a']), pendingBen: 'a', pendingCara: 'a' },
      {
        ben: place(['c'], ['b', 'a']),
        cara: place(['c'], ['b'], ['a']),
        wire: 'right',
        pendingCara: 'a',
        log: ['#42', 'task.moved', 'Ben'],
        statusCara: '409 conflict',
      },
      {
        ben: place(['c'], ['b', 'a']),
        cara: place(['c'], ['b', 'a']),
        flashCara: 'a',
        log: ['#42', 'task.moved', 'Ben'],
        statusCara: 'Ben moved it first',
      },
    ],
  },
  {
    id: 'recovery',
    label: 'Recovery',
    caption: 'Offline work stays on screen. On reconnect, missed events replay in order and queued writes land exactly once.',
    frames: [
      { ben: place(['c'], ['b', 'a']), cara: place(['c', 'd'], ['b', 'a']), offline: true, pendingCara: 'd', statusCara: 'Offline, 1 waiting' },
      { ben: place([], ['b', 'a'], ['c']), cara: place(['c', 'd'], ['b', 'a']), offline: true, pendingCara: 'd', statusCara: 'Offline, 1 waiting', log: ['#43', 'task.moved', 'Ben'] },
      { ben: place([], ['b', 'a'], ['c']), cara: place(['d'], ['b', 'a'], ['c']), wire: 'right', pendingCara: 'd', flashCara: 'c', statusCara: 'Replaying from #42', log: ['#43', 'replayed', 'Cara'] },
      { ben: place(['d'], ['b', 'a'], ['c']), cara: place(['d'], ['b', 'a'], ['c']), wire: 'left', flashBen: 'd', log: ['#44', 'task.created', 'Cara'] },
    ],
  },
  {
    id: 'isolation',
    label: 'Isolation',
    caption: 'Other branches get nothing. The database itself refuses to return their rows, and their sockets never see the event.',
    frames: [
      { ben: place(['d'], ['b', 'a'], ['c']), cara: place(['d'], ['b', 'a'], ['c']), berlinFocus: true },
      { ben: place([], ['b', 'a', 'd'], ['c']), cara: place(['d'], ['b', 'a'], ['c']), wire: 'right', berlinFocus: true, log: ['#45', 'task.moved', 'Ben'] },
      { ben: place([], ['b', 'a', 'd'], ['c']), cara: place([], ['b', 'a', 'd'], ['c']), flashCara: 'd', berlinFocus: true, log: ['#45', 'task.moved', 'Ben'] },
      { ben: place([], ['b', 'a', 'd'], ['c']), cara: place([], ['b', 'a', 'd'], ['c']), berlinFocus: true, berlinProbe: true, log: ['404', 'cross-tenant read', 'Blocked'] },
    ],
  },
];

const FRAME_MS = 1500;

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function MiniBoard({ name, tone, layout, pending, flash, status, offline }) {
  const cards = Object.values(layout).flatMap((ids, columnIndex) =>
    ids.map((id, row) => ({ id, columnIndex, row })),
  );
  return (
    <div className={`mini${offline ? ' mini-offline' : ''}`}>
      <div className="mini-bar">
        <span className="mini-dot" style={{ background: tone }} aria-hidden="true" />
        <span className="mini-name">{name}</span>
        <span className="mini-status">{status ?? (offline ? 'Offline' : 'Live')}</span>
      </div>
      <div className="mini-stage">
        {COLUMNS.map((title, index) => (
          <div className="mini-column" key={title} style={{ '--col': index }}>
            <span>{title}</span>
          </div>
        ))}
        {cards
          .sort((x, y) => (x.id < y.id ? -1 : 1))
          .map(({ id, columnIndex, row }) => (
            <div
              key={id}
              className={`mini-card${pending === id ? ' is-pending' : ''}${flash === id ? ' is-flash' : ''}`}
              style={{ '--col': columnIndex, '--row': row, '--flash': tone }}
            >
              {CARDS[id]}
            </div>
          ))}
      </div>
    </div>
  );
}

export function LoginShowcase() {
  const [reduced] = useState(prefersReducedMotion);
  const [playing, setPlaying] = useState(!reduced);
  const [position, setPosition] = useState({ scene: 0, frame: reduced ? SCENES[0].frames.length - 1 : 0 });

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      setPosition(({ scene, frame }) =>
        frame + 1 < SCENES[scene].frames.length
          ? { scene, frame: frame + 1 }
          : { scene: (scene + 1) % SCENES.length, frame: 0 },
      );
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [playing]);

  const scene = SCENES[position.scene];
  const frame = scene.frames[position.frame];

  return (
    <figure className="showcase" aria-label="Illustration of live sync, conflict handling, recovery and tenant isolation">
      <div className="showcase-tabs" role="tablist" aria-label="Choose what to see">
        {SCENES.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={index === position.scene}
            className={index === position.scene ? 'is-active' : ''}
            onClick={() => setPosition({ scene: index, frame: reduced ? item.frames.length - 1 : 0 })}
          >
            {item.label}
          </button>
        ))}
        {!reduced && (
          <button type="button" className="showcase-pause" onClick={() => setPlaying(!playing)}>
            {playing ? 'Pause' : 'Play'}
          </button>
        )}
      </div>

      <div className="showcase-rig">
        <MiniBoard name="Ben · Mumbai" tone="#2f6f8f" layout={frame.ben} pending={frame.pendingBen} flash={frame.flashBen} />
        <div className={`wire${frame.wire ? ` wire-${frame.wire}` : ''}`} key={`${position.scene}-${position.frame}`} aria-hidden="true">
          <span className="wire-packet" />
        </div>
        <MiniBoard
          name="Cara · Mumbai"
          tone="#7a5c99"
          layout={frame.cara}
          pending={frame.pendingCara}
          flash={frame.flashCara}
          status={frame.statusCara}
          offline={frame.offline}
        />
      </div>

      <div className="showcase-foot">
        <div className="event-line mono" aria-hidden="true">
          {frame.log ? (
            <span key={frame.log.join()} className="event-entry">
              <b>{frame.log[0]}</b> {frame.log[1]} <i>{frame.log[2]}</i>
            </span>
          ) : (
            <span className="event-idle">waiting for the next event</span>
          )}
        </div>
        <div className={`berlin${frame.berlinFocus ? ' is-focus' : ''}${frame.berlinProbe ? ' is-probe' : ''}`}>
          <span className="mini-dot" aria-hidden="true" />
          <span>Berlin</span>
          <span className="mono">{frame.berlinProbe ? 'blocked' : '0 events received'}</span>
        </div>
      </div>

      <figcaption key={scene.id} className="showcase-caption">{scene.caption}</figcaption>
    </figure>
  );
}
