import { useBoard } from '../store/board.js';
import { canAdminTenant, useRole, useSession } from '../store/session.js';
import { PresenceBar } from './PresenceBar.jsx';
import { SyncStatus } from './SyncStatus.jsx';
import { ROLE_LABELS } from '../lib/format.js';
import { Avatar, Icon, MenuItem, Popover } from './ui.jsx';

function Switcher({ kicker, value, items, onSelect, label, footer }) {
  const session = useSession.getState;
  return (
    <Popover
      className="switcher"
      label={label}
      onOpen={() => session().loadOrganizations().catch(() => {})}
      trigger={
        <>
          <span className="switcher-kicker">{kicker}</span>
          <span className="switcher-value">{value ?? 'None'}</span>
          <Icon name="chevron" size={14} />
        </>
      }
    >
      {(close) => (
        <div className="menu" role="menu">
          {items.map((item) => (
            <MenuItem
              key={item.id}
              active={item.active}
              onClick={() => {
                onSelect(item.id);
                close();
              }}
            >
              <span>{item.name}</span>
              <small>{item.note}</small>
            </MenuItem>
          ))}
          {!items.length && <p className="menu-empty">Nothing here yet</p>}
          {footer?.(close)}
        </div>
      )}
    </Popover>
  );
}

export function TopBar({ onOpenSettings, onToggleActivity, activityOpen }) {
  const user = useSession((state) => state.user);
  const organizations = useSession((state) => state.organizations);
  const tenants = useSession((state) => state.tenants);
  const orgId = useSession((state) => state.orgId);
  const tenantId = useSession((state) => state.tenantId);
  const selectOrg = useSession((state) => state.selectOrg);
  const selectTenant = useSession((state) => state.selectTenant);
  const logout = useSession((state) => state.logout);
  const role = useRole();
  const undo = useBoard((state) => state.undo);
  const redo = useBoard((state) => state.redo);
  const lastUndo = useBoard((state) => state.past.at(-1)?.label);
  const lastRedo = useBoard((state) => state.future.at(-1)?.label);

  const org = organizations.find((o) => o.id === orgId);
  const tenant = tenants.find((t) => t.id === tenantId);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand">Tenant Flow</div>
        <nav className="scope" aria-label="Organization and branch">
          <Switcher
            kicker="Organization"
            label={`Organization: ${org?.name ?? 'none'}. Change organization`}
            value={org?.name}
            items={organizations.map((o) => ({ id: o.id, name: o.name, active: o.id === orgId, note: ROLE_LABELS[o.role] }))}
            onSelect={(id) => selectOrg(id)}
            footer={(close) => (
              <MenuItem
                onClick={() => {
                  close();
                  onOpenSettings('new-org');
                }}
              >
                <Icon name="plus" size={14} /> New organization
              </MenuItem>
            )}
          />
          <span className="scope-slash" aria-hidden="true">/</span>
          <Switcher
            kicker="Branch"
            label={`Branch: ${tenant?.name ?? 'none'}. Change branch`}
            value={tenant?.name}
            items={tenants.map((t) => ({ id: t.id, name: t.name, active: t.id === tenantId, note: ROLE_LABELS[t.role] }))}
            onSelect={(id) => selectTenant(id)}
            footer={
              org?.role === 'org_admin'
                ? (close) => (
                    <MenuItem
                      onClick={() => {
                        close();
                        onOpenSettings('new-branch');
                      }}
                    >
                      <Icon name="plus" size={14} /> New branch
                    </MenuItem>
                  )
                : undefined
            }
          />
        </nav>
      </div>

      <div className="topbar-right">
        <PresenceBar />
        <SyncStatus />
        <div className="toolgroup">
          <button type="button" className="icon-button" disabled={!lastUndo} onClick={undo} title={lastUndo ? `Undo ${lastUndo}` : 'Nothing to undo'} aria-label="Undo">
            <Icon name="undo" />
          </button>
          <button type="button" className="icon-button" disabled={!lastRedo} onClick={redo} title={lastRedo ? `Redo ${lastRedo}` : 'Nothing to redo'} aria-label="Redo">
            <Icon name="redo" />
          </button>
          <button
            type="button"
            className={`icon-button${activityOpen ? ' is-active' : ''}`}
            onClick={onToggleActivity}
            disabled={!tenantId}
            title="Activity"
            aria-label="Activity"
            aria-pressed={activityOpen}
          >
            <Icon name="activity" />
          </button>
          {(canAdminTenant(role) || org?.role === 'org_admin') && (
            <button type="button" className="icon-button" onClick={() => onOpenSettings('branch')} title="Settings" aria-label="Settings">
              <Icon name="settings" />
            </button>
          )}
        </div>
        <Popover
          className="user-menu"
          align="end"
          label={`Account: ${user?.name}`}
          trigger={<Avatar name={user?.name} color={user?.color} />}
        >
          {() => (
            <div className="menu">
              <div className="menu-header">
                <strong>{user?.name}</strong>
                <small>{user?.email}</small>
                {role && <small>{ROLE_LABELS[role]} in {tenant?.name}</small>}
              </div>
              <MenuItem onClick={() => logout()}>Sign out</MenuItem>
            </div>
          )}
        </Popover>
      </div>
    </header>
  );
}
