import { Router } from 'express';
import { z } from 'zod';
import { authenticate, idParam, opIdFrom, parseBody, requireTenant } from '../../http/access.js';
import { createTask, deleteTask, getTask, listTasks, moveTask, restoreTask, updateTask } from './service.js';

const title = z.string().trim().min(1).max(300);
const description = z.string().max(20_000);
const priority = z.enum(['low', 'medium', 'high', 'urgent']);
const dueDate = z.iso.date().nullable();
const assigneeId = z.uuid().nullable();

const CreateBody = z.object({
  id: z.uuid().optional(),
  columnId: z.uuid(),
  title,
  description: description.optional(),
  priority: priority.optional(),
  dueDate: dueDate.optional(),
  assigneeId: assigneeId.optional(),
  afterId: z.uuid().nullish(),
  beforeId: z.uuid().nullish(),
});
const UpdateBody = z.object({
  patch: z.object({ title, description, priority, dueDate, assigneeId }).partial().strict(),
  baseVersion: z.number().int().nonnegative(),
});
const MoveBody = z.object({
  columnId: z.uuid(),
  afterId: z.uuid().nullish(),
  beforeId: z.uuid().nullish(),
  baseVersion: z.number().int().nonnegative(),
});
const RestoreBody = z.object({
  columnId: z.uuid().optional(),
  afterId: z.uuid().nullish(),
  beforeId: z.uuid().nullish(),
});

// Mounted at /api/tenants/:tenantId
export const taskRoutes = Router({ mergeParams: true });
taskRoutes.use(authenticate);

taskRoutes.get('/boards/:boardId/tasks', requireTenant(), async (req, res) => {
  const boardId = idParam(req, 'boardId', 'Board');
  res.json({ tasks: await listTasks(req.access, boardId) });
});

taskRoutes.post('/tasks', requireTenant(), async (req, res) => {
  const result = await createTask(req.access, parseBody(CreateBody, req), opIdFrom(req));
  res.status(201).json(result);
});

taskRoutes.get('/tasks/:taskId', requireTenant(), async (req, res) => {
  res.json({ task: await getTask(req.access, idParam(req, 'taskId', 'Task')) });
});

taskRoutes.patch('/tasks/:taskId', requireTenant(), async (req, res) => {
  const id = idParam(req, 'taskId', 'Task');
  res.json(await updateTask(req.access, id, parseBody(UpdateBody, req), opIdFrom(req)));
});

taskRoutes.post('/tasks/:taskId/move', requireTenant(), async (req, res) => {
  const id = idParam(req, 'taskId', 'Task');
  res.json(await moveTask(req.access, id, parseBody(MoveBody, req), opIdFrom(req)));
});

taskRoutes.post('/tasks/:taskId/restore', requireTenant(), async (req, res) => {
  const id = idParam(req, 'taskId', 'Task');
  res.json(await restoreTask(req.access, id, parseBody(RestoreBody, req), opIdFrom(req)));
});

taskRoutes.delete('/tasks/:taskId', requireTenant(), async (req, res) => {
  const id = idParam(req, 'taskId', 'Task');
  res.json(await deleteTask(req.access, id, opIdFrom(req)));
});
