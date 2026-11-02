import { create } from 'zustand';

let nextId = 1;

export const useToasts = create((set) => ({
  toasts: [],
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

/** tone: 'info' | 'warning' | 'error' */
export function toast(message, tone = 'info') {
  const id = nextId++;
  useToasts.setState((state) => ({ toasts: [...state.toasts.slice(-3), { id, message, tone }] }));
  setTimeout(() => useToasts.getState().dismiss(id), tone === 'info' ? 4000 : 7000);
}
