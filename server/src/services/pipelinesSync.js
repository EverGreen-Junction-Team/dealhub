// pipelinesSync.js — daily catalogue sync for pipelines + pipeline_stages.
//
// GHL doesn't emit webhooks for pipeline/stage definition changes. Daily
// reconciliation is the only reliable path — same pattern as tagsSync +
// customFieldsSync.
//
// Single API call per location:
//
//   GET /opportunities/pipelines?locationId=X
//     → { pipelines: [{ id, name, stages: [...], showInFunnel, ... }] }
//
// One request returns everything nested. We split it: UPSERT pipelines
// first, then unroll and UPSERT each stage into pipeline_stages (with
// pipeline_id denormalised for cheap analytics joins).
//
// Soft-delete: never DROP. Any row NOT touched this run gets is_active
// = false. Historical stage_history rows still reference these IDs long
// after a stage is retired, so they must remain resolvable.

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';
import { recordSyncRun } from './syncRunLog.js';

// Strip the nested stages[] from the pipeline object before storing as
// raw_pipeline — stages have their own table, no need to duplicate the
// storage cost inside the pipeline JSONB.
function pipelineWithoutStages(p) {
  const { stages, ...rest } = p || {};
  return rest;
}

async function upsertPipeline(locationId, p) {
  await rawQuery(
    `INSERT INTO pipelines
       (location_id, pipeline_id, name, position,
        show_in_funnel, show_in_pie_chart, use_opportunity_probability,
        color_render_mode, is_active, last_synced_at, raw_pipeline,
        imported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, true, now(), $9, now(), now())
     ON CONFLICT (location_id, pipeline_id) DO UPDATE SET
       name                        = COALESCE(EXCLUDED.name, pipelines.name),
       position                    = COALESCE(EXCLUDED.position, pipelines.position),
       show_in_funnel              = EXCLUDED.show_in_funnel,
       show_in_pie_chart           = EXCLUDED.show_in_pie_chart,
       use_opportunity_probability = EXCLUDED.use_opportunity_probability,
       color_render_mode           = EXCLUDED.color_render_mode,
       is_active                   = true,
       last_synced_at              = now(),
       raw_pipeline                = EXCLUDED.raw_pipeline,
       updated_at                  = now()`,
    [
      locationId, p.id, p.name || null,
      p.position != null ? String(p.position) : null,
      typeof p.showInFunnel === 'boolean' ? p.showInFunnel : null,
      typeof p.showInPieChart === 'boolean' ? p.showInPieChart : null,
      typeof p.useOpportunityProbability === 'boolean' ? p.useOpportunityProbability : null,
      typeof p.colorRenderMode === 'string' ? p.colorRenderMode : null,
      pipelineWithoutStages(p)
    ]
  );
}

async function upsertStage(locationId, pipelineId, s) {
  await rawQuery(
    `INSERT INTO pipeline_stages
       (location_id, stage_id, pipeline_id, name, position,
        show_in_funnel, show_in_pie_chart, win_probability, color,
        is_active, last_synced_at, raw_stage,
        imported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, true, now(), $10, now(), now())
     ON CONFLICT (location_id, stage_id) DO UPDATE SET
       pipeline_id       = EXCLUDED.pipeline_id,
       name              = COALESCE(EXCLUDED.name, pipeline_stages.name),
       position          = COALESCE(EXCLUDED.position, pipeline_stages.position),
       show_in_funnel    = EXCLUDED.show_in_funnel,
       show_in_pie_chart = EXCLUDED.show_in_pie_chart,
       win_probability   = EXCLUDED.win_probability,
       color             = EXCLUDED.color,
       is_active         = true,
       last_synced_at    = now(),
       raw_stage         = EXCLUDED.raw_stage,
       updated_at        = now()`,
    [
      locationId, s.id, pipelineId, s.name || null,
      typeof s.position === 'number' ? s.position : null,
      typeof s.showInFunnel === 'boolean' ? s.showInFunnel : null,
      typeof s.showInPieChart === 'boolean' ? s.showInPieChart : null,
      typeof s.stageWinProbability === 'number' ? Math.round(s.stageWinProbability) : null,
      typeof s.color === 'string' ? s.color : null,
      s
    ]
  );
}

export async function syncPipelinesForLocation(install) {
  const locationId = install.location_id;
  const startedAt = new Date();

  try {
    const { data } = await ghlRequest(install, {
      method: 'GET',
      url: `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`
    });
    const pipelines = Array.isArray(data?.pipelines) ? data.pipelines : [];

    let pipelineCount = 0;
    let stageCount = 0;
    for (const p of pipelines) {
      if (!p?.id) continue;
      await upsertPipeline(locationId, p);
      pipelineCount++;
      const stages = Array.isArray(p.stages) ? p.stages : [];
      for (const s of stages) {
        if (!s?.id) continue;
        try {
          await upsertStage(locationId, p.id, s);
          stageCount++;
        } catch (err) {
          logger.warn(
            { locationId, pipelineId: p.id, stageId: s.id, err, code: err.code, detail: err.detail },
            'pipelinesSync: stage upsert failed — skipped'
          );
        }
      }
    }

    // Soft-delete pass — anything for this location NOT touched this run
    // is gone from GHL. Stages first because they FK to pipelines; then
    // pipelines. We never DROP either — historical stage_history rows
    // still need to resolve these IDs.
    const { rowCount: stagesDeactivated } = await rawQuery(
      `UPDATE pipeline_stages
          SET is_active = false, updated_at = now()
        WHERE location_id = $1
          AND (last_synced_at IS NULL OR last_synced_at < $2)
          AND is_active = true`,
      [locationId, startedAt]
    );
    const { rowCount: pipelinesDeactivated } = await rawQuery(
      `UPDATE pipelines
          SET is_active = false, updated_at = now()
        WHERE location_id = $1
          AND (last_synced_at IS NULL OR last_synced_at < $2)
          AND is_active = true`,
      [locationId, startedAt]
    );

    logger.info(
      { locationId, pipelineCount, stageCount, pipelinesDeactivated, stagesDeactivated },
      'pipelinesSync: location synced'
    );
    await recordSyncRun({
      jobName: 'pipelinesSync',
      objectType: 'pipelines',
      locationId,
      scope: 'location',
      status: 'success',
      startedAt,
      stats: { pipelineCount, stageCount, pipelinesDeactivated, stagesDeactivated }
    });
    return { pipelineCount, stageCount, pipelinesDeactivated, stagesDeactivated };
  } catch (err) {
    logger.warn(
      {
        locationId,
        err,
        code: err.code,
        detail: err.detail,
        status: err.response?.status,
        body: err.response?.data
      },
      'pipelinesSync: location failed'
    );
    await recordSyncRun({
      jobName: 'pipelinesSync',
      objectType: 'pipelines',
      locationId,
      scope: 'location',
      status: 'failed',
      startedAt,
      error: err.message
    });
    return { pipelineCount: 0, stageCount: 0, error: err.message };
  }
}

// Sync every active install. Called from the daily cron. Failures on one
// location don't stop the others.
export async function syncPipelinesForAllInstalls() {
  const startedAt = new Date();
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );
  if (rows.length === 0) {
    logger.info('pipelinesSync: no active installs — skipping');
    await recordSyncRun({
      jobName: 'pipelinesSync', objectType: 'pipelines',
      scope: 'all', status: 'success', startedAt,
      stats: { locations: 0, totalPipelines: 0, totalStages: 0 }
    });
    return { locations: 0 };
  }

  let totalPipelines = 0;
  let totalStages = 0;
  let locationsFailed = 0;
  for (const { location_id: locationId } of rows) {
    const install = await getActiveInstall(locationId);
    if (!install) continue;
    const { pipelineCount, stageCount, error } = await syncPipelinesForLocation(install);
    totalPipelines += pipelineCount || 0;
    totalStages += stageCount || 0;
    if (error) locationsFailed++;
  }
  logger.info(
    { locations: rows.length, totalPipelines, totalStages, locationsFailed, durationMs: Date.now() - startedAt.getTime() },
    'pipelinesSync: complete'
  );
  await recordSyncRun({
    jobName: 'pipelinesSync', objectType: 'pipelines',
    scope: 'all',
    status: locationsFailed === 0 ? 'success' : (locationsFailed === rows.length ? 'failed' : 'partial'),
    startedAt,
    stats: { locations: rows.length, totalPipelines, totalStages, locationsFailed }
  });
  return { locations: rows.length, totalPipelines, totalStages };
}
