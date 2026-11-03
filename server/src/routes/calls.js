// /api/calls — Conversation Point for the dashboard.
//
//   GET  /                       list calls (filters: contactId, opportunityId, userId, status, q, limit, before)
//   GET  /:id                    one call + transcript + signed recording link + job states
//   POST /:id/retry              re-queue a step  { step: 'match'|'download'|'transcribe'|'ghl_sync' }
//   PATCH /:id/links             manual contact / user / deal override
//   GET  /providers              connector config for this location (secrets masked)
//   PUT  /providers/:provider    set api key / webhook secret / settings
//   POST /providers/:provider/register-webhook   create the webhook on the provider
//   POST /providers/:provider/sync-users         provider users → call_user_map (auto, by email)
//   GET  /user-map               rep mapping rows
//   PUT  /user-map               upsert one mapping { keyType, key, userId }
//   DELETE /user-map             remove one { keyType, key }

import express from 'express';
import { requireSession } from './auth.js';
import { withTenant, rawQuery } from '../db.js';
import { config } from '../config.js';
import { getProvider, listProviders } from '../conversationPoint/providers/index.js';
import { getProviderConfig, upsertProviderConfig, listProviderConfigs } from '../conversationPoint/providerConfig.js';
import { enqueue, jobsForCall, STEPS } from '../conversationPoint/callStore.js';
import { signRecordingUrl } from '../conversationPoint/recordingStore.js';
import { syncProviderUsers } from '../conversationPoint/userSync.js';
import { logger } from '../utils/logger.js';

export const callsRouter = express.Router();
callsRouter.use(requireSession);

const CALL_COLS = `
  c.id, c.provider, c.provider_call_id, c.direction, c.result,
  c.from_e164, c.to_e164, c.from_number, c.to_number, c.customer_number, c.our_number, c.extension,
  c.provider_user_name, c.provider_user_email,
  c.started_at, c.answered_at, c.ended_at, c.duration_seconds, c.talk_seconds,
  c.recording_status, c.recording_channels, c.recording_duration_seconds, c.recording_error,
  c.transcript_status, c.match_status,
  c.contact_id, c.contact_match_method, c.user_id, c.user_match_method,
  c.opportunity_id, c.deal_match_status, c.deal_match_rule, c.deal_match_confidence,
  c.ghl_message_id, c.ghl_sync_status, c.ghl_sync_error, c.created_at, c.updated_at,
  ct.first_name AS contact_first_name, ct.last_name AS contact_last_name, ct.company_name AS contact_company,
  u.name AS user_name,
  o.name AS opportunity_name, o.current_stage_name AS opportunity_stage`;

const CALL_JOINS = `
  LEFT JOIN contacts ct ON ct.location_id = c.location_id AND ct.contact_id = c.contact_id
  LEFT JOIN users u ON u.location_id = c.location_id AND u.user_id = c.user_id
  LEFT JOIN opportunities o ON o.location_id = c.location_id AND o.opportunity_id = c.opportunity_id`;

function shape(r, locationId) {
  return {
    id: r.id,
    provider: r.provider,
    providerCallId: r.provider_call_id,
    direction: r.direction,
    result: r.result,
    from: r.from_e164 || r.from_number,
    to: r.to_e164 || r.to_number,
    customerNumber: r.customer_number,
    ourNumber: r.our_number,
    extension: r.extension,
    startedAt: r.started_at,
    answeredAt: r.answered_at,
    endedAt: r.ended_at,
    durationSeconds: r.duration_seconds,
    talkSeconds: r.talk_seconds,
    recording: {
      status: r.recording_status,
      channels: r.recording_channels,
      durationSeconds: r.recording_duration_seconds != null ? Number(r.recording_duration_seconds) : null,
      error: r.recording_error,
      url: r.recording_status === 'stored' ? signRecordingUrl(locationId, r.id) : null
    },
    transcriptStatus: r.transcript_status,
    matchStatus: r.match_status,
    contact: r.contact_id ? {
      id: r.contact_id,
      name: [r.contact_first_name, r.contact_last_name].filter(Boolean).join(' ') || null,
      company: r.contact_company || null,
      method: r.contact_match_method
    } : null,
    user: r.user_id ? { id: r.user_id, name: r.user_name || r.provider_user_name || null, method: r.user_match_method }
      : (r.provider_user_name ? { id: null, name: r.provider_user_name, method: 'none' } : null),
    deal: r.opportunity_id ? {
      id: r.opportunity_id, name: r.opportunity_name, stage: r.opportunity_stage,
      status: r.deal_match_status, rule: r.deal_match_rule, confidence: r.deal_match_confidence != null ? Number(r.deal_match_confidence) : null
    } : { id: null, status: r.deal_match_status, rule: r.deal_match_rule },
    ghl: { status: r.ghl_sync_status, messageId: r.ghl_message_id, error: r.ghl_sync_error },
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// ─── list ────────────────────────────────────────────────────────────────

callsRouter.get('/', async (req, res) => {
  const locationId = req.locationId;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const where = ['c.location_id = $1'];
  const params = [locationId];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.contactId) add('c.contact_id = ?', String(req.query.contactId));
  if (req.query.opportunityId) add('c.opportunity_id = ?', String(req.query.opportunityId));
  if (req.query.userId) add('c.user_id = ?', String(req.query.userId));
  if (req.query.status) add('c.match_status = ?', String(req.query.status));
  if (req.query.direction) add('c.direction = ?', String(req.query.direction));
  if (req.query.before) add('c.started_at < ?', new Date(String(req.query.before)));
  if (req.query.q) {
    params.push(`%${String(req.query.q).replace(/\D/g, '')}%`);
    where.push(`(regexp_replace(COALESCE(c.from_number,''), '\\D', '', 'g') LIKE $${params.length}
             OR regexp_replace(COALESCE(c.to_number,''), '\\D', '', 'g') LIKE $${params.length})`);
  }
  params.push(limit + 1);

  try {
    const rows = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${CALL_COLS} FROM calls c ${CALL_JOINS}
          WHERE ${where.join(' AND ')}
          ORDER BY c.started_at DESC NULLS LAST, c.created_at DESC
          LIMIT $${params.length}`,
        params
      );
      return rows;
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      calls: page.map((r) => shape(r, locationId)),
      hasMore,
      nextBefore: hasMore ? page[page.length - 1].started_at : null
    });
  } catch (err) {
    logger.error({ err, locationId }, 'calls: list failed');
    res.status(500).json({ error: 'Could not load calls' });
  }
});

// ─── one ─────────────────────────────────────────────────────────────────

callsRouter.get('/:id([0-9a-fA-F-]{36})', async (req, res) => {
  const locationId = req.locationId;
  const id = String(req.params.id);
  try {
    const data = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${CALL_COLS} FROM calls c ${CALL_JOINS} WHERE c.location_id = $1 AND c.id = $2`,
        [locationId, id]
      );
      if (!rows[0]) return null;
      const t = await client.query(
        `SELECT text, segments, language, model, speaker_method, duration_seconds, silence_stats, status, error, transcribed_at
           FROM call_transcripts WHERE call_id = $1`,
        [id]
      );
      return { call: rows[0], transcript: t.rows[0] || null };
    });
    if (!data) return res.status(404).json({ error: 'Call not found' });
    const jobs = await jobsForCall(id);
    const t = data.transcript;
    res.json({
      call: shape(data.call, locationId),
      transcript: t ? {
        status: t.status, error: t.error, text: t.text, segments: t.segments || [],
        language: t.language, model: t.model, speakerMethod: t.speaker_method,
        durationSeconds: t.duration_seconds != null ? Number(t.duration_seconds) : null,
        silence: t.silence_stats, transcribedAt: t.transcribed_at
      } : null,
      jobs
    });
  } catch (err) {
    logger.error({ err, locationId, id }, 'calls: get failed');
    res.status(500).json({ error: 'Could not load this call' });
  }
});

// ─── retry a step ────────────────────────────────────────────────────────

callsRouter.post('/:id([0-9a-fA-F-]{36})/retry', async (req, res) => {
  const locationId = req.locationId;
  const id = String(req.params.id);
  const step = String(req.body?.step || 'match');
  if (!STEPS.includes(step)) return res.status(400).json({ error: `step must be one of ${STEPS.join(', ')}` });
  const { rows } = await rawQuery(`SELECT id FROM calls WHERE location_id = $1 AND id = $2`, [locationId, id]);
  if (!rows[0]) return res.status(404).json({ error: 'Call not found' });
  await enqueue(id, locationId, step, { force: true });
  res.json({ ok: true, step });
});

// ─── manual links ────────────────────────────────────────────────────────

callsRouter.patch('/:id([0-9a-fA-F-]{36})/links', async (req, res) => {
  const locationId = req.locationId;
  const id = String(req.params.id);
  const { contactId, userId, opportunityId } = req.body || {};
  const sets = []; const params = [locationId, id];
  const set = (col, v, methodCol) => {
    params.push(v || null); sets.push(`${col} = $${params.length}`);
    if (methodCol) sets.push(`${methodCol} = 'manual'`);
  };
  if (contactId !== undefined) set('contact_id', contactId, 'contact_match_method');
  if (userId !== undefined) set('user_id', userId, 'user_match_method');
  if (opportunityId !== undefined) {
    set('opportunity_id', opportunityId);
    sets.push(`deal_match_status = 'manually_resolved'`, `deal_match_rule = 'manual'`, `deal_match_confidence = 1.0`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'nothing to change' });
  sets.push(`match_status = CASE WHEN contact_id IS NOT NULL AND user_id IS NOT NULL AND opportunity_id IS NOT NULL THEN 'matched'
                                 WHEN contact_id IS NULL AND user_id IS NULL AND opportunity_id IS NULL THEN 'unmatched'
                                 ELSE 'partial' END`);
  const { rowCount } = await rawQuery(
    `UPDATE calls SET ${sets.join(', ')}, updated_at = now() WHERE location_id = $1 AND id = $2`, params
  );
  if (!rowCount) return res.status(404).json({ error: 'Call not found' });
  res.json({ ok: true });
});

// ─── provider config ─────────────────────────────────────────────────────

callsRouter.get('/providers', async (req, res) => {
  const rows = await listProviderConfigs(req.locationId);
  res.json({
    available: listProviders(),
    configured: rows,
    webhookUrlTemplate: `${config.publicBaseUrl.replace(/\/$/, '')}/webhooks/calls/{provider}/${req.locationId}`,
    transcription: config.conversationPoint.openaiApiKey ? config.conversationPoint.transcribeModel : null,
    ghlSync: !!config.conversationPoint.ghlCallProviderId
  });
});

callsRouter.put('/providers/:provider', async (req, res) => {
  const providerName = String(req.params.provider).toLowerCase();
  try { getProvider(providerName); } catch { return res.status(404).json({ error: 'unknown provider' }); }
  const { enabled, apiKey, webhookSecret, providerAccountId, settings } = req.body || {};
  const row = await upsertProviderConfig(req.locationId, providerName, { enabled, apiKey, webhookSecret, providerAccountId, settings });
  res.json({ ok: true, provider: row });
});

callsRouter.post('/providers/:provider/register-webhook', async (req, res) => {
  const providerName = String(req.params.provider).toLowerCase();
  const locationId = req.locationId;
  try {
    const provider = getProvider(providerName);
    const cfg = await getProviderConfig(locationId, providerName);
    const url = `${config.publicBaseUrl.replace(/\/$/, '')}/webhooks/calls/${providerName}/${locationId}`;
    const created = await provider.api(cfg).createWebhook(url, provider.webhookTopics);
    const webhookId = created?.id || created?.data?.id || null;
    const secret = created?.secret || created?.data?.secret || created?.signing_secret || null;
    await upsertProviderConfig(locationId, providerName, { webhookId, webhookSecret: secret || undefined });
    res.json({ ok: true, url, webhookId, secretStored: !!secret, raw: created });
  } catch (err) {
    logger.error({ err, locationId, providerName }, 'calls: register-webhook failed');
    res.status(err.code === 'NO_API_KEY' ? 400 : 502).json({ error: err.message, detail: err.body || null });
  }
});

callsRouter.post('/providers/:provider/sync-users', async (req, res) => {
  const providerName = String(req.params.provider).toLowerCase();
  try {
    const result = await syncProviderUsers(req.locationId, providerName);
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err, locationId: req.locationId, providerName }, 'calls: sync-users failed');
    res.status(err.code === 'NO_API_KEY' ? 400 : 502).json({ error: err.message, detail: err.body || null });
  }
});

// ─── user map ────────────────────────────────────────────────────────────

callsRouter.get('/user-map', async (req, res) => {
  const { rows } = await rawQuery(
    `SELECT m.provider, m.key_type, m.key, m.user_id, COALESCE(u.name, m.user_name) AS user_name, m.source, m.updated_at
       FROM call_user_map m LEFT JOIN users u ON u.location_id = m.location_id AND u.user_id = m.user_id
      WHERE m.location_id = $1 ORDER BY m.provider, m.key_type, m.key`,
    [req.locationId]
  );
  res.json({ rows });
});

callsRouter.put('/user-map', async (req, res) => {
  const { provider = 'allo', keyType, key, userId } = req.body || {};
  if (!['user', 'extension', 'number', 'email'].includes(keyType)) return res.status(400).json({ error: 'keyType must be user | extension | number | email' });
  if (!key || !userId) return res.status(400).json({ error: 'key and userId are required' });
  const { rows } = await rawQuery(
    `SELECT name FROM users WHERE location_id = $1 AND user_id = $2`, [req.locationId, userId]
  );
  await rawQuery(
    `INSERT INTO call_user_map (location_id, provider, key_type, key, user_id, user_name, source)
     VALUES ($1,$2,$3,$4,$5,$6,'manual')
     ON CONFLICT (location_id, provider, key_type, key) DO UPDATE SET
       user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name, source = 'manual', updated_at = now()`,
    [req.locationId, String(provider).toLowerCase(), keyType, String(key).trim(), userId, rows[0]?.name || null]
  );
  res.json({ ok: true });
});

callsRouter.delete('/user-map', async (req, res) => {
  const { provider = 'allo', keyType, key } = req.body || {};
  const { rowCount } = await rawQuery(
    `DELETE FROM call_user_map WHERE location_id = $1 AND provider = $2 AND key_type = $3 AND key = $4`,
    [req.locationId, String(provider).toLowerCase(), keyType, String(key || '')]
  );
  res.json({ ok: true, removed: rowCount });
});
