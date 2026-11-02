import { usePresence, uniqueUsers } from '../store/presence.js';
import { useSession } from '../store/session.js';
import { Avatar, Popover } from './ui.jsx';

const MAX_SHOWN = 4;

export function PresenceBar() {
  const entries = usePresence((state) => state.entries);
  const me = useSession((state) => state.user);
  const boards = useSession((state) => state.boards);
  const users = uniqueUsers(entries);
  if (!users.length) return null;

  const others = users.filter((user) => user.userId !== me?.id);
  const count = others.length;
  const whereIs = (user) => boards.find((board) => board.id === user.boardId)?.name ?? 'In this branch';

  return (
    <Popover
      className="presence"
      align="end"
      label={count ? `${count} other ${count === 1 ? 'person' : 'people'} online in this branch` : 'Only you are online in this branch'}
      trigger={
        <span className="presence-stack" data-testid="presence">
          {users.slice(0, MAX_SHOWN).map((user) => (
            <Avatar key={user.userId} name={user.name} color={user.color} size="sm" ring />
          ))}
          {users.length > MAX_SHOWN && <span className="avatar avatar-sm avatar-more">+{users.length - MAX_SHOWN}</span>}
        </span>
      }
    >
      {() => (
        <div className="presence-list">
          <h3>Online in this branch</h3>
          <ul>
            {users.map((user) => (
              <li key={user.userId}>
                <Avatar name={user.name} color={user.color} size="sm" />
                <span>
                  {user.name}
                  {user.userId === me?.id && ' (you)'}
                  <small>{whereIs(user)}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}
