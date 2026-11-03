// taskPatch.js — validate and map a task create/edit for GHL's task endpoints.
//
// Dependency-free so it can be unit-tested without config, a database or the
// network. Same reasoning as contactPatch.js: a mistyped field name here means
// an edit the UI reports as saved and GHL never receives.
//
// Endpoints this feeds (API version 2021-04-15), all nested on the CONTACT:
//   POST /contacts/{contactId}/tasks
//   PUT  /contacts/{contactId}/tasks/{taskId}
//   PUT  /contacts/{contactId}/tasks/{taskId}/completed
//   DELETE /contacts/{contactId}/tasks/{taskId}

// The five fields both endpoints accept. Anything else is dropped rather than
// passed through — an unknown key makes GHL reject the whole request, so one
// typo would lose the valid fields alongside it.
const WRITABLE = new Set(['title', 'body', 'dueDate', 'completed', 'assignedTo']);

// Create requires title, dueDate and completed — including `completed` on a
// brand-new task, which reads as odd but is what the API demands.
const REQUIRED_ON_CREATE = ['title', 'dueDate', 'completed'];

// OUR limits, not GoHighLevel's — theirs are more permissive. Set here rather
// than only in the dashboard so the rule is enforced whatever calls the API,
// and so the UI's character counter can be read off one source.
//
// body: 2000. A task description is an instruction to a rep, not a document;
// anything longer belongs in a note (65000) and linked. Was 5000, which was
// this file's own guess at a reasonable ceiling.
const MAX_LENGTHS = { title: 1500, body: 2000 };

export class TaskWriteError extends Error {
  // `reason` is a machine-readable code for the cases where the message alone
  // is not enough to act on — currently 'reauth_required' vs 'not_installed',
  // which need different fixes (clear a flag / reinstall the app) and used to
  // share one message.
  constructor(message, { status = 400, field = null, reason = null } = {}) {
    super(message);
    this.name = 'TaskWriteError';
    this.status = status;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * ISO 8601 with an offset, which is what GHL documents ("2020-10-25T11:00:00Z").
 *
 * A bare date ("2026-09-01") or a local datetime with no zone is accepted from
 * the client and normalised, rather than rejected: the UI's date picker emits
 * YYYY-MM-DD, and asking every caller to build a UTC timestamp invites each one
 * to do it slightly differently. A date with no time means end of that day in
 * UTC — a task "due 1 September" is not overdue at 00:01 that morning.
 */
export function toGhlDueDate(value, { field = 'dueDate' } = {}) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new TaskWriteError('Due date must be a date', { field });
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TaskWriteError('That due date is not a valid date', { field });
    }
    return value.toISOString();
  }

  const raw = value.trim();

  // Date only — no time, no zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T23:59:59.000Z`);
    if (Number.isNaN(d.getTime())) {
      throw new TaskWriteError('That due date is not a valid date', { field });
    }
    // Guard against JS's silent rollover: new Date('2026-02-31') is 3 March.
    if (!d.toISOString().startsWith(raw)) {
      throw new TaskWriteError('That due date is not a valid date', { field });
    }
    return d.toISOString();
  }

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new TaskWriteError(
      'Due date must be a date like 2026-09-01 or 2026-09-01T11:00:00Z',
      { field }
    );
  }
  return d.toISOString();
}

/**
 * Validate and normalise a task body before it reaches GHL.
 *
 * @param {object} input        client-supplied fields
 * @param {object} opts
 * @param {boolean} opts.create true for POST (enforces required fields)
 * @returns {{ patch: object, dropped: string[] }}
 */
export function buildTaskPatch(input = {}, { create = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TaskWriteError('Nothing to save', { status: 400 });
  }

  const patch = {};
  const dropped = [];

  for (const [key, value] of Object.entries(input)) {
    if (!WRITABLE.has(key)) {
      dropped.push(key);
      continue;
    }
    // undefined means "not being changed". Null and '' are deliberate clears
    // and must survive — except for the fields GHL requires, handled below.
    if (value === undefined) continue;

    if (key === 'completed') {
      if (typeof value !== 'boolean') {
        throw new TaskWriteError('Completed must be true or false', { field: 'completed' });
      }
      patch.completed = value;
      continue;
    }

    if (key === 'dueDate') {
      patch.dueDate = toGhlDueDate(value);
      continue;
    }

    if (key === 'title' || key === 'body') {
      if (typeof value !== 'string') {
        throw new TaskWriteError(`${key} must be text`, { field: key });
      }
      const trimmed = value.trim();
      if (trimmed.length > MAX_LENGTHS[key]) {
        throw new TaskWriteError(
          `${key === 'title' ? 'Title' : 'Description'} must be ` +
          `${MAX_LENGTHS[key]} characters or fewer`,
          { field: key }
        );
      }
      patch[key] = trimmed;
      continue;
    }

    // assignedTo — a GHL user id. We don't validate membership here (that
    // needs the location's user list); GHL 422s with its own message, which
    // names the problem better than a guess would.
    if (value === null || value === '') {
      patch.assignedTo = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw new TaskWriteError('Assignee must be a user id', { field: 'assignedTo' });
    }
    patch.assignedTo = value.trim();
  }

  if (create) {
    // `completed` defaults rather than erroring: every task this app creates
    // starts open, and making the caller state the obvious invites it to be
    // sent wrong. title and dueDate are genuinely the caller's to supply.
    if (patch.completed === undefined) patch.completed = false;

    for (const field of REQUIRED_ON_CREATE) {
      if (patch[field] === undefined || patch[field] === null || patch[field] === '') {
        throw new TaskWriteError(
          field === 'title'
            ? 'A task needs a title'
            : 'A task needs a due date',
          { field }
        );
      }
    }
  } else if (Object.keys(patch).length === 0) {
    throw new TaskWriteError('Nothing to update', { status: 400 });
  }

  // An update that clears the title would leave an unreadable row in the queue,
  // and GHL treats title as required on create — so treat '' as a mistake
  // rather than passing it through.
  if (!create && 'title' in patch && patch.title === '') {
    throw new TaskWriteError('A task needs a title', { field: 'title' });
  }

  return { patch, dropped };
}
