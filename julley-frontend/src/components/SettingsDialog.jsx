import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { canAdminTenant, useRole, useSession } from '../store/session.js';
import { PeoplePicker } from './PeoplePicker.jsx';
import { ROLE_LABELS } from '../lib/format.js';
import { Avatar, Dialog, Icon, NameForm } from './ui.jsx';

function ConfirmDelete({ label, warning, onConfirm }) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState(null);
  if (!armed) {
    return (
      <button type="button" className="button button-danger-quiet" onClick={() => setArmed(true)}>
        <Icon name="trash" size={14} /> {label}
      </button>
    );
  }
  return (
    <div className="confirm-delete">
      <p>{warning}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="button" onClick={() => setArmed(false)}>Cancel</button>
        <button
          type="button"
          className="button button-danger"
          onClick={async () => {
            try {
              await onConfirm();
            } catch (err) {
              setError(err.message);
            }
          }}
        >
          {label}
        </button>
      </div>
    </div>
  );
}

function BranchMembers({ tenantId }) {
  const members = useSession((state) => state.members);
  const reloadMembers = useSession((state) => state.reloadMembers);
  const me = useSession((state) => state.user);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState(null);

  const run = async (action) => {
    setError(null);
    try {
      await action();
      await reloadMembers();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="settings-section">
      <h3>People in this branch</h3>
      <ul className="member-list">
        {members.map((member) => (
          <li key={member.id}>
            <Avatar name={member.name} color={member.color} size="sm" />
            <span className="member-name">
              {member.name}{member.userId === me?.id && ' (you)'}
              <small>{member.email}</small>
            </span>
            {member.tenantId ? (
              <>
                <select
                  aria-label={`Role for ${member.name}`}
                  value={member.role}
                  onChange={(event) => run(() => api.patch(`/tenants/${tenantId}/members/${member.id}`, { role: event.target.value }))}
                >
                  <option value="member">Member</option>
                  <option value="tenant_admin">Branch admin</option>
                </select>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${member.name}`}
                  title="Remove from branch"
                  onClick={() => run(() => api.del(`/tenants/${tenantId}/members/${member.id}`))}
                >
                  <Icon name="close" size={14} />
                </button>
              </>
            ) : (
              <span className="member-role">{ROLE_LABELS[member.role]}</span>
            )}
          </li>
        ))}
      </ul>
      <form
        className="member-add"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            await api.post(`/tenants/${tenantId}/members`, { email: email.trim(), role });
            setEmail('');
          });
        }}
      >
        <PeoplePicker label="Email of the person to add" searchPath={`/tenants/${tenantId}/members/search`} value={email} onChange={setEmail} />
        <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value)}>
          <option value="member">Member</option>
          <option value="tenant_admin">Branch admin</option>
        </select>
        <button type="submit" className="button">Add</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

function OrgAdmins({ orgId }) {
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const me = useSession((state) => state.user);

  const load = useCallback(async () => {
    const data = await api.get(`/organizations/${orgId}/members`);
    setMembers(data.members.filter((member) => member.role === 'org_admin'));
  }, [orgId]);

  useEffect(() => {
    let active = true;
    api.get(`/organizations/${orgId}/members`).then(
      (data) => {
        if (active) setMembers(data.members.filter((member) => member.role === 'org_admin'));
      },
      (err) => {
        if (active) setError(err.message);
      },
    );
    return () => {
      active = false;
    };
  }, [orgId]);

  const run = async (action) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="settings-section">
      <h3>Organization admins</h3>
      <p className="muted">These people can enter and manage every branch.</p>
      <ul className="member-list">
        {members.map((member) => (
          <li key={member.id}>
            <Avatar name={member.name} color={member.color} size="sm" />
            <span className="member-name">
              {member.name}{member.userId === me?.id && ' (you)'}
              <small>{member.email}</small>
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${member.name}`}
              onClick={() => run(() => api.del(`/organizations/${orgId}/members/${member.id}`))}
            >
              <Icon name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="member-add"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            await api.post(`/organizations/${orgId}/members`, { email: email.trim() });
            setEmail('');
          });
        }}
      >
        <PeoplePicker label="Email of the admin to add" searchPath={`/organizations/${orgId}/members/search`} value={email} onChange={setEmail} />
        <button type="submit" className="button">Add admin</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

export function SettingsDialog({ initialTab, onClose }) {
  const orgId = useSession((state) => state.orgId);
  const tenantId = useSession((state) => state.tenantId);
  const organizations = useSession((state) => state.organizations);
  const tenants = useSession((state) => state.tenants);
  const createOrganization = useSession((state) => state.createOrganization);
  const createTenant = useSession((state) => state.createTenant);
  const renameOrganization = useSession((state) => state.renameOrganization);
  const renameTenant = useSession((state) => state.renameTenant);
  const deleteOrganization = useSession((state) => state.deleteOrganization);
  const deleteTenant = useSession((state) => state.deleteTenant);
  const role = useRole();
  const org = organizations.find((o) => o.id === orgId);
  const tenant = tenants.find((t) => t.id === tenantId);
  const isOrgAdmin = org?.role === 'org_admin';
  const [tab, setTab] = useState(initialTab);

  if (tab === 'new-org') {
    return (
      <Dialog title="New organization" onClose={onClose} width={420}>
        <p className="muted">You'll be its admin, and can add branches and people next.</p>
        <NameForm label="Organization name" submitLabel="Create organization" onCancel={onClose} onSubmit={async (name) => {
          await createOrganization(name);
          onClose();
        }} />
      </Dialog>
    );
  }
  if (tab === 'new-branch') {
    return (
      <Dialog title={`New branch in ${org?.name}`} onClose={onClose} width={420}>
        <NameForm label="Branch name" submitLabel="Create branch" placeholder="e.g. Mumbai" onCancel={onClose} onSubmit={async (name) => {
          await createTenant(name);
          onClose();
        }} />
      </Dialog>
    );
  }

  return (
    <Dialog title="Settings" onClose={onClose} width={620}>
      <div className="tabs" role="tablist">
        {tenant && canAdminTenant(role) && (
          <button type="button" role="tab" aria-selected={tab === 'branch'} className={tab === 'branch' ? 'is-active' : ''} onClick={() => setTab('branch')}>
            {tenant.name}
          </button>
        )}
        {isOrgAdmin && (
          <button type="button" role="tab" aria-selected={tab === 'org'} className={tab === 'org' ? 'is-active' : ''} onClick={() => setTab('org')}>
            {org.name}
          </button>
        )}
      </div>

      {tab === 'branch' && tenant && (
        <>
          <section className="settings-section">
            <NameForm key={tenant.id + tenant.name} label="Branch name" initial={tenant.name} submitLabel="Save name" onSubmit={renameTenant} />
          </section>
          <BranchMembers tenantId={tenant.id} />
          {isOrgAdmin && (
            <section className="settings-section">
              <ConfirmDelete
                label="Delete branch"
                warning={`This permanently deletes ${tenant.name}, with all its boards, tasks and history.`}
                onConfirm={async () => {
                  await deleteTenant();
                  onClose();
                }}
              />
            </section>
          )}
        </>
      )}
      {tab === 'org' && org && (
        <>
          <section className="settings-section">
            <NameForm key={org.id + org.name} label="Organization name" initial={org.name} submitLabel="Save name" onSubmit={renameOrganization} />
          </section>
          <OrgAdmins orgId={org.id} />
          <section className="settings-section">
            <ConfirmDelete
              label="Delete organization"
              warning={`This permanently deletes ${org.name}, with every branch, board and task in it.`}
              onConfirm={async () => {
                await deleteOrganization();
                onClose();
              }}
            />
          </section>
        </>
      )}
    </Dialog>
  );
}
