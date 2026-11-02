import { create } from 'zustand';
import { api } from '../lib/api.js';

const MAX_EVENTS = 300;

export const useActivity = create((set, get) => ({
  tenantId: null,
  events: [],
  nextBeforeSeq: null,
  loading: false,

  async load(tenantId) {
    set({ tenantId, events: [], nextBeforeSeq: null, loading: true });
    try {
      const data = await api.get(`/tenants/${tenantId}/activity?limit=50`);
      if (get().tenantId !== tenantId) return;
      // Events that arrived live during the fetch are already in the list.
      const seen = new Set(get().events.map((event) => event.seq));
      set({
        events: [...get().events, ...data.events.filter((event) => !seen.has(event.seq))],
        nextBeforeSeq: data.nextBeforeSeq,
        loading: false,
      });
    } catch {
      if (get().tenantId === tenantId) set({ loading: false });
    }
  },

  async loadMore() {
    const { tenantId, nextBeforeSeq, loading } = get();
    if (!nextBeforeSeq || loading) return;
    set({ loading: true });
    try {
      const data = await api.get(`/tenants/${tenantId}/activity?limit=50&beforeSeq=${nextBeforeSeq}`);
      if (get().tenantId !== tenantId) return;
      set({ events: [...get().events, ...data.events], nextBeforeSeq: data.nextBeforeSeq, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  add(event) {
    if (get().tenantId !== event.tenantId) return;
    set({ events: [event, ...get().events].slice(0, MAX_EVENTS) });
  },

  reset() {
    set({ tenantId: null, events: [], nextBeforeSeq: null, loading: false });
  },
}));
