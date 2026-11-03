import express from 'express';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { logger } from '../utils/logger.js';
import { getActiveInstall, explainInactiveInstall } from '../services/ghlClient.js';
import { syncBusinessesForLocation } from '../services/businessesSync.js';
import { syncTagsForLocation } from '../services/tagsSync.js';
import { syncCustomFieldsForLocation } from '../services/customFieldsSync.js';
import { backfillUsersForLocation } from '../services/userWriter.js';
import { syncOpportunitiesForLocation } from '../services/opportunitiesSync.js';
import { invalidateBusinessContext } from '../services/ai/businessContext.js';
import {
  listSkills, createSkill, updateSkill, deleteSkill, SkillValidationError
} from '../services/ai/skillStore.js';
import { describeView, listUsableViews } from '../services/ai/skillValidator.js';

import {
  getSignature, saveSignature, deleteSignature, SignatureError
} from '../services/signatureStore.js';

export const controlRouter = express.Router();
controlRouter.use(requireSession);

// Control panel — v5.
//
// One markdown file of business context per sub-account, plus the read-only
// Qualification headings (from GHL's own custom fields).
//
//   GET    /api/control                    → the page
//   PUT    /api/control/business-context   → upload or replace the file
//   GET    /api/control/business-context/download
//
// v5 retired the four-section Control centre. The tone_samples / products /
// location_ai_settings tables from migration 049 are deliberately left in
// place — dropping them would lose data if the decision reverses — but nothing
// reads them any more and nothing writes them.
//
// Qualification headings survive because they aren't ours: they're the
// location's GHL opportunity custom fields (opportunity.meddic_N), read
// straight from ghl_custom_field_definitions.

// ── GET /api/control ──────────────────────────────────────────────────
// The whole page in one round trip.

controlRouter.get('/', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const data = await withTenant(locationId, async (client) => {
      const [ctx, meddicFields] = await Promise.all([
        // The file's metadata plus a preview. The full content isn't sent to
        // the page — 18 KB per render for text nobody reads inline, when
        // Download already serves the whole thing.
        client.query(
          `SELECT filename, size_bytes, content_version, replace_count,
                  uploaded_by, uploaded_at,
                  left(content, 2000) AS preview,
                  length(content)     AS content_length
             FROM business_context
            WHERE location_id = $1`,
          [locationId]
        ),
        // Qualification headings — the location's own GHL opportunity custom
        // fields, ordered on the key's trailing number so meddic_10 follows
        // meddic_9 (a text sort puts it between 1 and 2).
        client.query(
          `SELECT field_id, field_key, display_name, field_type, is_active,
                  placeholder
             FROM ghl_custom_field_definitions
            WHERE location_id = $1
              AND object_type = 'opportunity'
              AND field_key ~ '^opportunity[.]meddic_[0-9]+$'
            ORDER BY (regexp_replace(field_key, '^.*_', ''))::int ASC`,
          [locationId]
        )
      ]);
      return { ctx: ctx.rows[0] || null, meddicFields: meddicFields.rows };
    });

    res.json({
      businessContext: data.ctx
        ? {
            filename: data.ctx.filename,
            sizeBytes: data.ctx.size_bytes,
            version: data.ctx.content_version,
            replaceCount: data.ctx.replace_count,
            uploadedBy: data.ctx.uploaded_by,
            uploadedAt: data.ctx.uploaded_at,
            preview: data.ctx.preview,
            // So the UI can say the preview is partial rather than implying
            // the file is only 2000 characters long.
            truncated: data.ctx.content_length > 2000
          }
        : null,
      meddicFields: data.meddicFields.map((f) => ({
        fieldId: f.field_id,
        fieldKey: f.field_key,
        name: f.display_name,
        type: f.field_type,
        active: f.is_active,
        description: f.placeholder,
        index: Number(String(f.field_key).replace(/^.*_/, '')) || null
      }))
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/control failed');
    next(err);
  }
});

// ── PUT /api/control/business-context ─────────────────────────────────
// Upload or replace the file. Text in the JSON body rather than multipart:
// it's markdown, the client reads it with FileReader anyway, and this avoids a
// multipart dependency for a single text field.

const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;   // 2 MB — far above the ~18 KB real files

controlRouter.put('/business-context', async (req, res, next) => {
  const locationId = req.locationId;
  const content = typeof req.body?.content === 'string' ? req.body.content : null;
  const filename = (req.body?.filename || 'business-context.md').toString().slice(0, 200);

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > MAX_CONTEXT_BYTES) {
    return res.status(400).json({ error: 'File is too large (2 MB maximum)' });
  }

  try {
    const row = await withTenant(locationId, async (client) => {
      const r = await client.query(
        `INSERT INTO business_context
           (location_id, content, filename, size_bytes, content_version,
            replace_count, uploaded_by, uploaded_at)
         VALUES ($1, $2, $3, $4, 1, 0, $5, now())
         ON CONFLICT (location_id) DO UPDATE
            SET content         = EXCLUDED.content,
                filename        = EXCLUDED.filename,
                size_bytes      = EXCLUDED.size_bytes,
                -- Monotonic: this is the cache key, so it must never repeat.
                content_version = business_context.content_version + 1,
                replace_count   = business_context.replace_count + 1,
                uploaded_by     = EXCLUDED.uploaded_by,
                uploaded_at     = now()
         RETURNING filename, size_bytes, content_version, replace_count,
                   uploaded_by, uploaded_at, left(content, 2000) AS preview,
                   length(content) AS content_length`,
        [locationId, content, filename, sizeBytes, req.session?.userId || null]
      );
      return r.rows[0];
    });

    // Drop the in-process copy so the next question reads the new text rather
    // than waiting out the TTL.
    invalidateBusinessContext(locationId);

    logger.info(
      { locationId, sizeBytes, version: row.content_version },
      'control: business context saved'
    );
    res.json({
      businessContext: {
        filename: row.filename,
        sizeBytes: row.size_bytes,
        version: row.content_version,
        replaceCount: row.replace_count,
        uploadedBy: row.uploaded_by,
        uploadedAt: row.uploaded_at,
        preview: row.preview,
        truncated: row.content_length > 2000
      }
    });
  } catch (err) {
    logger.error({ err, locationId }, 'PUT /api/control/business-context failed');
    next(err);
  }
});

// ── GET /api/control/business-context/download ────────────────────────
// The whole file, as a download. Separate from the page payload so a render
// never carries content nobody reads inline.

controlRouter.get('/business-context/download', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const row = await withTenant(locationId, async (client) => {
      const r = await client.query(
        `SELECT content, filename FROM business_context WHERE location_id = $1`,
        [locationId]
      );
      return r.rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'No business context uploaded' });

    // Quote the filename and strip quotes from it — an unescaped quote in a
    // Content-Disposition header truncates the name.
    const safe = String(row.filename || 'business-context.md').replace(/["\\]/g, '');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.send(row.content);
  } catch (err) {
    logger.error({ err, locationId }, 'GET business-context/download failed');
    next(err);
  }
});

// ── AI skills ─────────────────────────────────────────────────────────
// A skill exposes one database view to the AI as a tool. It stores NO SQL —
// see migration 083 and services/ai/skillValidator.js for why, and for the
// security_invoker check that keeps a view from bypassing row-level security.
//
//   GET    /api/control/skills               → all of them, enabled or not
//   POST   /api/control/skills               → create
//   PUT    /api/control/skills/:id           → edit
//   DELETE /api/control/skills/:id           → remove
//   GET    /api/control/skills/views        → every view a skill may point at
//   GET    /api/control/skills/views/:name   → a view's real columns, for the form

// Every validation failure names the field that caused it, so the form can
// point at the offending input rather than showing a banner.
function sendSkillError(res, err, next) {
  if (err instanceof SkillValidationError) {
    return res.status(err.status || 400).json({ error: err.message, field: err.field });
  }
  return next(err);
}

// ── Answers a rep marked wrong ───────────────────────────────────────
//
// The read side of thumbs-down. Captured since 073 and never surfaced, which
// made the button a suggestion box with no lid — a rep spends effort on a
// report that goes nowhere and stops bothering once they notice.
//
// Each row carries what ran, so a report is actionable rather than a guess:
// a wrong skill choice is a description to fix, wrong rows are a view to fix,
// and a misread of correct rows is a prompt to fix.
// ── POST /api/control/sync/:kind ──────────────────────────────────────
// Run one catalogue sync NOW, for this sub-account only.
//
// WHY THIS EXISTS. Businesses, tags and custom field definitions arrive by
// no webhook at all — GHL fires nothing when one is created, renamed or
// deleted. They land only on the 3am reconciliation, so a business created
// at 09:00 is invisible here until the next morning. That is correct for a
// catalogue and wrong for a person who has just made one and come looking.
//
// SCOPED TO THE CALLER'S OWN LOCATION, always. The per-location variant is
// used rather than the ForAllInstalls one: a rep pressing a button in their
// sub-account must not set every other tenant's sync running.
//
// SYNCHRONOUS on purpose. These are small catalogues — tens to low hundreds
// of rows — so the call returns in a second or two and the caller can show
// what changed. A fire-and-forget 202 would leave the UI guessing whether to
// reload, which is the thing the button exists to settle.
const SYNCABLE = {
  businesses:   { run: syncBusinessesForLocation,  label: 'Businesses' },
  tags:         { run: syncTagsForLocation,        label: 'Tags' },
  customFields: { run: syncCustomFieldsForLocation, label: 'Custom fields' },
  // Users: roles, agency/account type, sub-account membership, two-way
  // email sync. The nightly usersSync runs the same function; this is the
  // "I just changed a rep's role in GHL" button.
  // `synced` is the field SyncButton reads — the contract every sync
  // service here keeps. This first returned { users: n } and the button
  // showed "0 users" over a sync that had written six.
  // THIS sub-account's users, each fetched on its own — see
  // backfillUsersForLocation. `synced` is the field SyncButton reads.
  users:        { run: async (install) => {
    const r = await backfillUsersForLocation(install);
    return { synced: r.count };
  }, label: 'Users' },
  // Deals: the nightly sweep, now. Refreshes every deal GHL lists and marks
  // deleted the ones it no longer does — the "this deal is gone in GHL but
  // still shows here" button.
  deals:        { run: async (install) => {
    const r = await syncOpportunitiesForLocation(install);
    return { synced: r.upserted || 0, deleted: r.deleted || 0, error: r.error || undefined };
  }, label: 'Deals' }
};

controlRouter.post('/sync/:kind', async (req, res, next) => {
  const locationId = req.locationId;
  const kind = req.params.kind;
  const job = SYNCABLE[kind];
  logger.info({ locationId, kind, known: !!job }, 'control: manual sync starting');

  // An allow-list, not a lookup on whatever was passed: this takes a name
  // straight from the URL and would otherwise invite calling anything that
  // happened to be in scope.
  if (!job) {
    return res.status(400).json({
      error: 'Unknown sync', field: 'kind',
      allowed: Object.keys(SYNCABLE)
    });
  }

  try {
    const install = await getActiveInstall(locationId);
    if (!install) {
      const inactive = await explainInactiveInstall(locationId);
      return res.status(409).json({ error: inactive.message, reason: inactive.reason });
    }

    const started = Date.now();
    const result = await job.run(install);
    const ms = Date.now() - started;

    // The sync services report their own failures in the return value rather
    // than throwing, so a 200 here would claim success for a run that did
    // nothing. Surfaced as a 502: the fault is GHL's end, not the request.
    if (result && result.error) {
      logger.warn({ locationId, kind, err: result.error }, 'control: sync reported a failure');
      return res.status(502).json({
        error: `${job.label} did not sync — ${result.error}`,
        kind
      });
    }

    logger.info({ locationId, kind, ...result, ms }, 'control: manual sync finished');
    return res.json({ ok: true, kind, label: job.label, ms, ...result });
  } catch (err) {
    logger.error({ err, locationId, kind }, 'POST /control/sync failed');
    return next(err);
  }
});

controlRouter.get('/corrections', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await withTenant(req.locationId, async (client) => {
      const r = await client.query(
        `SELECT * FROM vw_answer_corrections
          WHERE location_id = $1
          ORDER BY flagged_at DESC
          LIMIT $2`,
        [req.locationId, limit]
      );
      return r.rows;
    });
    res.json({ corrections: rows });
  } catch (err) { next(err); }
});

// ── Email signature ──────────────────────────────────────────────────
//
// Always the SESSION's own user, never a user id from the request. A rep
// editing a colleague's sign-off is not a feature anyone asked for, and
// taking the id from the body would make it one by accident — including for
// anyone who can reach the endpoint with curl.

controlRouter.get('/signature', async (req, res, next) => {
  try {
    const sig = await getSignature(req.locationId, req.session?.userId);
    res.json({ signature: sig });
  } catch (err) { next(err); }
});

controlRouter.put('/signature', async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      // A session without a user id cannot own a signature. Saying so beats a
      // 500 from the store, which would read as a server fault.
      return res.status(400).json({
        error: 'This session has no user id, so there is nobody to save a signature for.'
      });
    }
    const saved = await saveSignature(req.locationId, userId, req.body?.html ?? '', userId);
    res.json({ signature: saved });
  } catch (err) {
    if (err instanceof SignatureError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

controlRouter.delete('/signature', async (req, res, next) => {
  try {
    const removed = await deleteSignature(req.locationId, req.session?.userId);
    res.json({ removed });
  } catch (err) { next(err); }
});

controlRouter.get('/skills', async (req, res, next) => {
  try {
    res.json({ skills: await listSkills(req.locationId) });
  } catch (err) {
    logger.error({ err, locationId: req.locationId }, 'GET /api/control/skills failed');
    next(err);
  }
});

// Every view a skill could read, for the form's view dropdown.
//
// MUST be declared BEFORE /skills/views/:name. Express matches in order, and
// ":name" happily matches the literal string "views" — so registering this
// second would route GET /skills/views into describeView(locationId, 'views')
// and answer a 404 for a view nobody asked for.
controlRouter.get('/skills/views', async (req, res, next) => {
  try {
    res.json({ views: await listUsableViews(req.locationId) });
  } catch (err) {
    logger.error({ err, locationId: req.locationId }, 'GET /api/control/skills/views failed');
    next(err);
  }
});

// Powers the column pickers: the form offers real column names rather than
// asking someone to remember them, which is where typos come from.
controlRouter.get('/skills/views/:name', async (req, res, next) => {
  try {
    const { columns, columnComments, viewComment } =
      await describeView(req.locationId, req.params.name);
    // viewComment is what the view's author wrote about it. The form offers it
    // as the starting description rather than asking someone to write the same
    // sentence a second time, where it would drift the first time the view
    // changed.
    res.json({ view: req.params.name, columns, columnComments, viewComment });
  } catch (err) {
    sendSkillError(res, err, next);
  }
});

controlRouter.post('/skills', async (req, res, next) => {
  try {
    const skill = await createSkill(req.locationId, req.body || {}, req.session?.userId || null);
    res.status(201).json({ skill });
  } catch (err) {
    sendSkillError(res, err, next);
  }
});

controlRouter.put('/skills/:id', async (req, res, next) => {
  try {
    const skill = await updateSkill(
      req.locationId, req.params.id, req.body || {}, req.session?.userId || null
    );
    if (!skill) return res.status(404).json({ error: 'That skill no longer exists' });
    res.json({ skill });
  } catch (err) {
    sendSkillError(res, err, next);
  }
});

controlRouter.delete('/skills/:id', async (req, res, next) => {
  try {
    const gone = await deleteSkill(req.locationId, req.params.id);
    if (!gone) return res.status(404).json({ error: 'That skill no longer exists' });
    res.status(204).end();
  } catch (err) {
    logger.error({ err, locationId: req.locationId }, 'DELETE /api/control/skills failed');
    next(err);
  }
});
