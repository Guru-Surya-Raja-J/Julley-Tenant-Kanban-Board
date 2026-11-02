import { conflict } from '../http/errors.js';

function same(a, b) {
  return (a ?? null) === (b ?? null);
}

/**
 * Field-level optimistic concurrency.
 *
 * A field conflicts when someone else changed it after `baseVersion`, and the
 * incoming value differs from what is there now. Everything else merges. The
 * actor check means a user's own queued edits never conflict with each other.
 *
 * Returns the fields that really change, or throws a 409 describing the clash.
 */
export function resolvePatch({ current, patch, baseVersion, actorId, entity }) {
  const fieldVersions = current.fieldVersions ?? {};
  const changed = {};
  const conflicts = [];

  for (const [field, value] of Object.entries(patch)) {
    if (same(current[field], value)) continue;
    const last = fieldVersions[field];
    if (last && last.v > baseVersion && last.by !== actorId) {
      conflicts.push({ field, yours: value, theirs: current[field], changedBy: last.by });
    } else {
      changed[field] = value;
    }
  }

  if (conflicts.length) {
    throw conflict('EDIT_CONFLICT', `Someone else changed this ${entity} while you were editing`, {
      conflicts,
      current,
    });
  }
  return changed;
}

/** Throws if someone else already moved this row since the client last saw it. */
export function assertNotMovedSince({ current, baseVersion, actorId, entity }) {
  const last = current.fieldVersions?.position;
  if (last && last.v > baseVersion && last.by !== actorId) {
    throw conflict('MOVE_CONFLICT', `Someone else already moved this ${entity}`, {
      changedBy: last.by,
      current,
    });
  }
}

/** The fieldVersions map after applying a change at nextVersion. */
export function nextFieldVersions(current, fields, nextVersion, actorId) {
  const updated = { ...(current.fieldVersions ?? {}) };
  for (const field of fields) updated[field] = { v: nextVersion, by: actorId };
  return updated;
}

/** {field: {from, to}} for the activity log. */
export function describeChanges(current, changed) {
  return Object.fromEntries(
    Object.entries(changed).map(([field, to]) => [field, { from: current[field] ?? null, to }]),
  );
}
