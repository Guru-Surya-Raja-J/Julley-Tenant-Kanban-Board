import { create } from 'zustand';

export const usePresence = create((set) => ({
  entries: [],
  set: (entries) => set({ entries }),
}));

/** One entry per person: someone with three tabs open is still one person. */
export function uniqueUsers(entries) {
  const users = new Map();
  for (const entry of entries) {
    const existing = users.get(entry.userId);
    if (!existing) users.set(entry.userId, { ...entry });
    else if (!existing.boardId && entry.boardId) existing.boardId = entry.boardId;
  }
  return [...users.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Who else has each card open: {taskId: [entry, ...]}. */
export function viewersByTask(entries, myUserId) {
  const byTask = {};
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.taskId || entry.userId === myUserId) continue;
    const key = `${entry.taskId}:${entry.userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (byTask[entry.taskId] ??= []).push(entry);
  }
  return byTask;
}
