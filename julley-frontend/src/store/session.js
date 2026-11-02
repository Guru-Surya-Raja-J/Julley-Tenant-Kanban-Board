import { create } from 'zustand';
import { api, getToken, setToken, setUnauthorizedHandler } from '../lib/api.js';
import { RealtimeClient } from '../lib/realtime.js';
import { useActivity } from './activity.js';
import { configureBoardStore, useBoard } from './board.js';
import { usePresence } from './presence.js';
import { toast } from './toasts.js';

const SELECTION_KEY = 'tenant-flow.selection';

function loadSelection() {
  try {
    return JSON.parse(localStorage.getItem(SELECTION_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveSelection(patch) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ...loadSelection(), ...patch }));
  } catch {
    // A remembered selection is only a convenience.
  }
}

// The last event sequence applied for the subscribed tenant. Null means "start from now".
let lastSeq = null;

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const realtime = new RealtimeClient({
  url: wsUrl(),
  getToken,
  onStatus: (connection) => useSession.setState({ connection }),
  onOpen: () => {
    const { tenantId } = useSession.getState();
    if (tenantId) subscribeToTenant(tenantId);
    useBoard.getState().nudgeQueue();
  },
  onAuthFailed: () => useSession.getState().logout('Your session expired. Sign in again.'),
  onMessage: (message) => handleSocketMessage(message),
});

function subscribeToTenant(tenantId) {
  realtime.send({
    type: 'subscribe',
    tenantId,
    lastSeq,
    boardId: useBoard.getState().boardId,
  });
}

function sendPresence() {
  const { boardId, openTaskId } = useBoard.getState();
  realtime.send({ type: 'presence.update', boardId, taskId: openTaskId });
}

function handleSocketMessage(message) {
  const session = useSession.getState();
  switch (message.type) {
    case 'subscribed':
      if (message.tenantId !== session.tenantId) return;
      lastSeq ??= message.seq;
      usePresence.getState().set(message.presence);
      useSession.setState({ connection: 'live' });
      sendPresence();
      // A board that failed to load while offline can load now.
      if (useBoard.getState().status === 'error') useBoard.getState().refresh();
      return;
    case 'event':
      handleEvent(message.event);
      return;
    case 'presence':
      if (message.tenantId === session.tenantId) usePresence.getState().set(message.members);
      return;
    case 'resync.required':
      if (message.tenantId !== session.tenantId) return;
      lastSeq = message.seq;
      useBoard.getState().refresh();
      session.reloadTenantData();
      return;
    case 'subscription.revoked':
      if (message.tenantId !== session.tenantId) return;
      toast('You no longer have access to that branch.', 'warning');
      session.loadOrganizations();
      return;
    case 'error':
      if (message.code === 'NOT_FOUND' && message.tenantId === session.tenantId) {
        session.loadOrganizations();
      }
      return;
    default:
  }
}

function handleEvent(event) {
  const session = useSession.getState();
  if (event.tenantId !== session.tenantId || lastSeq === null) return;
  if (event.seq <= lastSeq) return;
  if (event.seq > lastSeq + 1) {
    // A message went missing. Replaying from the last good point repairs it.
    subscribeToTenant(session.tenantId);
    return;
  }
  lastSeq = event.seq;

  useActivity.getState().add(event);
  useBoard.getState().applyEvent(event, { myUserId: session.user?.id });

  const { action, payload } = event;
  if (action === 'board.created') {
    useSession.setState((s) => ({
      boards: s.boards.some((b) => b.id === payload.board.id) ? s.boards : [...s.boards, payload.board],
    }));
  } else if (action === 'board.updated') {
    useSession.setState((s) => ({ boards: s.boards.map((b) => (b.id === payload.board.id ? payload.board : b)) }));
  } else if (action === 'board.deleted') {
    const wasOpen = session.boardId === payload.board.id;
    useSession.setState((s) => ({ boards: s.boards.filter((b) => b.id !== payload.board.id) }));
    if (wasOpen) {
      if (event.actor?.id !== session.user?.id) toast(`${event.actor?.name ?? 'Someone'} deleted that board.`, 'warning');
      session.selectBoard(useSession.getState().boards[0]?.id ?? null);
    }
  } else if (action === 'tenant.updated') {
    useSession.setState((s) => ({
      tenants: s.tenants.map((t) => (t.id === payload.tenant.id ? { ...t, name: payload.tenant.name, version: payload.tenant.version } : t)),
    }));
  } else if (action.startsWith('member.')) {
    session.reloadMembers();
    if (payload.member?.userId === session.user?.id) session.loadOrganizations();
  }
}

export const useSession = create((set, get) => ({
  status: getToken() ? 'restoring' : 'signed-out', // restoring | signed-out | ready
  user: null,
  connection: 'closed',
  organizations: [],
  tenants: [],
  boards: [],
  members: [],
  orgId: null,
  tenantId: null,
  boardId: null,
  directoryLoading: false,

  async restore() {
    if (!getToken()) return;
    try {
      const { user } = await api.get('/auth/me');
      await get().enter(user);
    } catch (err) {
      if (err.network) {
        set({ status: 'restoring' });
        setTimeout(() => get().restore(), 2000);
        return;
      }
      setToken(null);
      set({ status: 'signed-out' });
    }
  },

  async signIn(path, body) {
    const { token, user } = await api.post(`/auth/${path}`, body);
    setToken(token);
    await get().enter(user);
  },

  async enter(user) {
    set({ user, status: 'ready' });
    realtime.connect();
    await get().loadOrganizations();
  },

  logout(message) {
    realtime.disconnect();
    setToken(null);
    lastSeq = null;
    useBoard.getState().clearAll();
    useActivity.getState().reset();
    usePresence.getState().set([]);
    set({
      status: 'signed-out',
      user: null,
      organizations: [],
      tenants: [],
      boards: [],
      members: [],
      orgId: null,
      tenantId: null,
      boardId: null,
    });
    if (message) toast(message, 'warning');
  },

  // --- the org -> tenant -> board chain ---------------------------------------

  /** Reloads organizations and keeps the current selection if it is still valid. */
  async loadOrganizations() {
    const { organizations } = await api.get('/organizations');
    set({ organizations });
    const saved = loadSelection();
    const { orgId } = get();
    const next =
      organizations.find((o) => o.id === orgId) ??
      organizations.find((o) => o.id === saved.orgId) ??
      organizations[0] ??
      null;
    if (next) await get().selectOrg(next.id, { keepTenant: next.id === orgId });
    else get().clearOrg();
  },

  clearOrg() {
    if (get().tenantId) realtime.send({ type: 'unsubscribe' });
    lastSeq = null;
    useBoard.getState().resetTenant(null);
    useActivity.getState().reset();
    usePresence.getState().set([]);
    set({ orgId: null, tenants: [], tenantId: null, boards: [], boardId: null, members: [] });
  },

  async selectOrg(orgId, { keepTenant = false } = {}) {
    if (!keepTenant && get().orgId !== orgId) set({ tenants: [] });
    set({ orgId });
    saveSelection({ orgId });
    const { tenants } = await api.get(`/organizations/${orgId}/tenants`);
    if (get().orgId !== orgId) return;
    set({ tenants });
    const saved = loadSelection();
    const current = get().tenantId;
    const next =
      tenants.find((t) => t.id === current) ??
      tenants.find((t) => t.id === saved.tenantId) ??
      tenants[0] ??
      null;
    if (next && next.id === current && keepTenant) return;
    await get().selectTenant(next?.id ?? null);
  },

  async selectTenant(tenantId) {
    if (get().tenantId !== tenantId && get().tenantId) realtime.send({ type: 'unsubscribe' });
    lastSeq = null;
    usePresence.getState().set([]);
    useBoard.getState().resetTenant(tenantId);
    set({ tenantId, boards: [], boardId: null, members: [] });
    if (!tenantId) {
      useActivity.getState().reset();
      return;
    }
    saveSelection({ tenantId });
    // Subscribe first: an event landing during the fetches below is then not missed.
    subscribeToTenant(tenantId);
    useActivity.getState().load(tenantId);
    await get().reloadTenantData();
    if (get().tenantId !== tenantId) return;
    const saved = loadSelection();
    const { boards } = get();
    const next = boards.find((b) => b.id === saved.boardId) ?? boards[0] ?? null;
    await get().selectBoard(next?.id ?? null);
  },

  async reloadTenantData() {
    const { tenantId } = get();
    if (!tenantId) return;
    const [{ boards }, { members }] = await Promise.all([
      api.get(`/tenants/${tenantId}/boards`),
      api.get(`/tenants/${tenantId}/members`),
    ]);
    if (get().tenantId === tenantId) set({ boards, members });
  },

  async reloadMembers() {
    const { tenantId } = get();
    if (!tenantId) return;
    try {
      const { members } = await api.get(`/tenants/${tenantId}/members`);
      if (get().tenantId === tenantId) set({ members });
    } catch {
      // Loses access is handled by the revocation message.
    }
  },

  async selectBoard(boardId) {
    const { tenantId } = get();
    set({ boardId });
    if (!boardId) {
      useBoard.getState().resetTenant(tenantId);
      sendPresence();
      return;
    }
    saveSelection({ boardId });
    const load = useBoard.getState().load(tenantId, boardId);
    sendPresence();
    await load;
  },

  // --- admin actions (not optimistic: these are rare, and their errors matter) ----

  async createOrganization(name) {
    const { organization } = await api.post('/organizations', { name });
    set((s) => ({ organizations: [...s.organizations, organization].sort((a, b) => a.name.localeCompare(b.name)) }));
    await get().selectOrg(organization.id);
    return organization;
  },

  async renameOrganization(name) {
    const { organization } = await api.patch(`/organizations/${get().orgId}`, { name });
    set((s) => ({ organizations: s.organizations.map((o) => (o.id === organization.id ? organization : o)) }));
  },

  async deleteOrganization() {
    await api.del(`/organizations/${get().orgId}`);
    set({ orgId: null, tenantId: null });
    await get().loadOrganizations();
  },

  async createTenant(name) {
    const { tenant } = await api.post(`/organizations/${get().orgId}/tenants`, { name });
    set((s) => ({ tenants: [...s.tenants, tenant].sort((a, b) => a.name.localeCompare(b.name)) }));
    await get().selectTenant(tenant.id);
    return tenant;
  },

  async renameTenant(name) {
    const { tenant } = await api.patch(`/tenants/${get().tenantId}`, { name });
    set((s) => ({ tenants: s.tenants.map((t) => (t.id === tenant.id ? tenant : t)) }));
  },

  async deleteTenant() {
    await api.del(`/tenants/${get().tenantId}`);
    set({ tenantId: null });
    await get().selectOrg(get().orgId);
  },

  async createBoard(name) {
    const { board } = await api.post(`/tenants/${get().tenantId}/boards`, { name });
    set((s) => ({ boards: s.boards.some((b) => b.id === board.id) ? s.boards : [...s.boards, board] }));
    await get().selectBoard(board.id);
  },

  async renameBoard(boardId, name) {
    const existing = get().boards.find((b) => b.id === boardId);
    const { board } = await api.patch(`/tenants/${get().tenantId}/boards/${boardId}`, {
      patch: { name },
      baseVersion: existing.version,
    });
    set((s) => ({ boards: s.boards.map((b) => (b.id === board.id ? board : b)) }));
  },

  async deleteBoard(boardId) {
    await api.del(`/tenants/${get().tenantId}/boards/${boardId}`);
    set((s) => ({ boards: s.boards.filter((b) => b.id !== boardId) }));
    if (get().boardId === boardId) await get().selectBoard(get().boards[0]?.id ?? null);
  },
}));

setUnauthorizedHandler(() => useSession.getState().logout('Your session expired. Sign in again.'));

configureBoardStore({
  nameOf: (userId) => useSession.getState().members.find((m) => m.userId === userId)?.name ?? 'Someone',
  onBoardGone: () => {
    const { boards, boardId } = useSession.getState();
    const remaining = boards.filter((b) => b.id !== boardId);
    useSession.setState({ boards: remaining });
    useSession.getState().selectBoard(remaining[0]?.id ?? null);
  },
});

// Tell the tenant which card is open whenever that changes.
useBoard.subscribe((state, previous) => {
  if (state.openTaskId !== previous.openTaskId) sendPresence();
});

// The browser knows about connectivity before a socket timeout would.
window.addEventListener('offline', () => realtime.dropForOffline());
window.addEventListener('online', () => {
  realtime.reconnectNow();
  useBoard.getState().nudgeQueue();
});

/** The caller's role in the current tenant. */
export function useRole() {
  return useSession((state) => state.tenants.find((t) => t.id === state.tenantId)?.role ?? null);
}

export const canAdminTenant = (role) => role === 'tenant_admin' || role === 'org_admin';
