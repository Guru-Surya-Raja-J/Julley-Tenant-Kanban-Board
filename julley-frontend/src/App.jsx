import { useEffect, useState } from 'react';
import { ActivityDrawer } from './components/ActivityDrawer.jsx';
import { BoardTabs } from './components/BoardTabs.jsx';
import { BoardView } from './components/BoardView.jsx';
import { ConflictDialog } from './components/ConflictDialog.jsx';
import { LoginScreen } from './components/LoginScreen.jsx';
import { SettingsDialog } from './components/SettingsDialog.jsx';
import { TaskPanel } from './components/TaskPanel.jsx';
import { TimeMachine } from './components/TimeMachine.jsx';
import { Toasts } from './components/Toasts.jsx';
import { TopBar } from './components/TopBar.jsx';
import { useBoard } from './store/board.js';
import { canAdminTenant, useRole, useSession } from './store/session.js';

function EmptyState({ onOpenSettings }) {
  const organizations = useSession((state) => state.organizations);
  const orgId = useSession((state) => state.orgId);
  const tenants = useSession((state) => state.tenants);
  const boards = useSession((state) => state.boards);
  const role = useRole();
  const org = organizations.find((o) => o.id === orgId);

  if (!organizations.length) {
    return (
      <div className="board-message">
        <h2>You're not in an organization yet</h2>
        <p>Create one, or ask an admin to add you using your email address.</p>
        <button type="button" className="button button-primary" onClick={() => onOpenSettings('new-org')}>New organization</button>
      </div>
    );
  }
  if (!tenants.length) {
    return (
      <div className="board-message">
        <h2>{org?.name} has no branches{org?.role === 'org_admin' ? ' yet' : ' you can see'}</h2>
        {org?.role === 'org_admin' ? (
          <>
            <p>Each branch gets its own boards, people and activity, separate from every other branch.</p>
            <button type="button" className="button button-primary" onClick={() => onOpenSettings('new-branch')}>New branch</button>
          </>
        ) : (
          <p>Ask an organization admin to add you to a branch.</p>
        )}
      </div>
    );
  }
  if (!boards.length) {
    return (
      <div className="board-message">
        <h2>No boards in this branch yet</h2>
        <p>{canAdminTenant(role) ? 'Use “Board” above to create the first one.' : 'A branch admin needs to create the first one.'}</p>
      </div>
    );
  }
  return null;
}

function Workspace() {
  const [settingsTab, setSettingsTab] = useState(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [historyBoardId, setHistoryBoardId] = useState(null);
  const tenantId = useSession((state) => state.tenantId);
  const boardId = useSession((state) => state.boardId);
  const undo = useBoard((state) => state.undo);
  const redo = useBoard((state) => state.redo);
  const openTask = useBoard((state) => state.openTask);
  // Tied to the board, so switching board or branch leaves the Time Machine.
  const historyOpen = Boolean(boardId) && historyBoardId === boardId;

  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
          if (event.target.closest('input, textarea, select')) return;
          event.preventDefault();
          redo();
        }
        return;
      }
      // Inside a text field, this is the browser's own undo of your typing.
      if (event.target.closest('input, textarea, select')) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return (
    <div className="app">
      <TopBar
        onOpenSettings={setSettingsTab}
        activityOpen={activityOpen && Boolean(tenantId)}
        onToggleActivity={() => setActivityOpen(!activityOpen)}
      />
      <BoardTabs
        historyOpen={historyOpen}
        onOpenHistory={() => {
          openTask(null);
          setHistoryBoardId(historyOpen ? null : boardId);
        }}
      />
      <div className="workspace">
        <main className="workspace-main">
          {historyOpen && <TimeMachine key={boardId} onClose={() => setHistoryBoardId(null)} />}
          {!historyOpen && (boardId ? <BoardView /> : <EmptyState onOpenSettings={setSettingsTab} />)}
        </main>
        {activityOpen && tenantId && <ActivityDrawer onClose={() => setActivityOpen(false)} />}
        <TaskPanel />
      </div>
      <ConflictDialog />
      {settingsTab && <SettingsDialog initialTab={settingsTab} onClose={() => setSettingsTab(null)} />}
    </div>
  );
}

export default function App() {
  const status = useSession((state) => state.status);
  const restore = useSession((state) => state.restore);

  useEffect(() => {
    restore();
  }, [restore]);

  return (
    <>
      {status === 'signed-out' && <LoginScreen />}
      {status === 'restoring' && <div className="splash" aria-busy="true">Tenant Flow</div>}
      {status === 'ready' && <Workspace />}
      <Toasts />
    </>
  );
}
