import { useState } from 'react';
import { canAdminTenant, useRole, useSession } from '../store/session.js';
import { Dialog, Icon, NameForm } from './ui.jsx';

export function BoardTabs({ onOpenHistory, historyOpen }) {
  const boards = useSession((state) => state.boards);
  const boardId = useSession((state) => state.boardId);
  const tenantId = useSession((state) => state.tenantId);
  const selectBoard = useSession((state) => state.selectBoard);
  const createBoard = useSession((state) => state.createBoard);
  const renameBoard = useSession((state) => state.renameBoard);
  const deleteBoard = useSession((state) => state.deleteBoard);
  const role = useRole();
  const [dialog, setDialog] = useState(null);
  const admin = canAdminTenant(role);
  const current = boards.find((board) => board.id === boardId);

  if (!tenantId) return null;

  return (
    <div className="board-tabs">
      <div className="board-tabs-list" role="tablist" aria-label="Boards">
        {boards.map((board) => (
          <button
            key={board.id}
            type="button"
            role="tab"
            aria-selected={board.id === boardId}
            className={`board-tab${board.id === boardId ? ' is-active' : ''}`}
            onClick={() => selectBoard(board.id)}
          >
            {board.name}
          </button>
        ))}
        {admin && (
          <button type="button" className="board-tab board-tab-new" onClick={() => setDialog('new')}>
            <Icon name="plus" size={14} /> Board
          </button>
        )}
      </div>
      {current && (
        <div className="board-tabs-actions">
          <button
            type="button"
            className={`text-button text-icon${historyOpen ? ' is-active' : ''}`}
            aria-pressed={historyOpen}
            onClick={onOpenHistory}
          >
            <Icon name="clock" size={14} /> Time Machine
          </button>
          {admin && (
            <>
              <button type="button" className="text-button" onClick={() => setDialog('rename')}>Rename</button>
              <button type="button" className="text-button text-danger" onClick={() => setDialog('delete')}>Delete</button>
            </>
          )}
        </div>
      )}

      {dialog === 'new' && (
        <Dialog title="New board" onClose={() => setDialog(null)} width={420}>
          <NameForm
            label="Board name"
            submitLabel="Create board"
            placeholder="e.g. Warehouse rollout"
            onCancel={() => setDialog(null)}
            onSubmit={async (name) => {
              await createBoard(name);
              setDialog(null);
            }}
          />
        </Dialog>
      )}
      {dialog === 'rename' && current && (
        <Dialog title="Rename board" onClose={() => setDialog(null)} width={420}>
          <NameForm
            label="Board name"
            initial={current.name}
            submitLabel="Save"
            onCancel={() => setDialog(null)}
            onSubmit={async (name) => {
              await renameBoard(current.id, name);
              setDialog(null);
            }}
          />
        </Dialog>
      )}
      {dialog === 'delete' && current && (
        <Dialog title={`Delete “${current.name}”?`} onClose={() => setDialog(null)} width={420}>
          <p>This deletes the board and all of its columns and tasks for everyone in this branch. It can't be undone.</p>
          <div className="form-actions">
            <button type="button" className="button" onClick={() => setDialog(null)}>Keep board</button>
            <button
              type="button"
              className="button button-danger"
              onClick={async () => {
                setDialog(null);
                await deleteBoard(current.id);
              }}
            >
              Delete board
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
