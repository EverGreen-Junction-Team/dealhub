import { withTenant } from '../../db.js';

// Persistence for ai_memories (migration 075) — Co-Pilot's "Personalization"
// feature. See the migration header for scope: explicit save and bulk
// import only, no automatic mid-chat extraction.

const MAX_CONTENT_LENGTH = 2000;
// A rep pasting a huge export should not be able to flood the prompt every
// memory gets injected into — capped well under anything that would crowd
// out the actual question.
const MAX_MEMORIES_PER_USER = 200;

export async function listMemories(locationId, userId) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `SELECT id, content, source, created_at, updated_at
         FROM ai_memories
        WHERE location_id = $1 AND user_id = $2 AND status = 'active'
        ORDER BY created_at DESC`,
      [locationId, userId]
    );
    return r.rows;
  });
}

export async function createMemory(locationId, { userId, content, source = 'explicit' }) {
  const trimmed = String(content || '').trim().slice(0, MAX_CONTENT_LENGTH);
  if (!trimmed) {
    const err = new Error('content is required');
    err.status = 400;
    throw err;
  }
  return withTenant(locationId, async (client) => {
    const { rows: [{ count }] } = await client.query(
      `SELECT count(*) FROM ai_memories WHERE location_id = $1 AND user_id = $2 AND status = 'active'`,
      [locationId, userId]
    );
    if (Number(count) >= MAX_MEMORIES_PER_USER) {
      const err = new Error(`At most ${MAX_MEMORIES_PER_USER} memories — delete one first.`);
      err.status = 400;
      throw err;
    }
    const r = await client.query(
      `INSERT INTO ai_memories (location_id, user_id, content, source)
       VALUES ($1, $2, $3, $4)
       RETURNING id, content, source, created_at, updated_at`,
      [locationId, userId, trimmed, source]
    );
    return r.rows[0];
  });
}

// Bulk import — a rep pasting the output of GHL's own "export memories"
// prompt, or a plain list of lines. Skips blanks and anything already over
// the length cap rather than failing the whole batch on one bad line.
export async function importMemories(locationId, { userId, memories }) {
  const list = Array.isArray(memories) ? memories : [];
  const cleaned = list
    .map((m) => String(m || '').trim())
    .filter((m) => m && m.length <= MAX_CONTENT_LENGTH);

  return withTenant(locationId, async (client) => {
    const { rows: [{ count }] } = await client.query(
      `SELECT count(*) FROM ai_memories WHERE location_id = $1 AND user_id = $2 AND status = 'active'`,
      [locationId, userId]
    );
    const room = MAX_MEMORIES_PER_USER - Number(count);
    const toInsert = cleaned.slice(0, Math.max(room, 0));

    let imported = 0;
    for (const content of toInsert) {
      await client.query(
        `INSERT INTO ai_memories (location_id, user_id, content, source)
         VALUES ($1, $2, $3, 'import')`,
        [locationId, userId, content]
      );
      imported++;
    }
    return {
      imported,
      skipped: cleaned.length - toInsert.length,
      limitReached: toInsert.length < cleaned.length
    };
  });
}

export async function deleteMemory(locationId, { userId, memoryId }) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `UPDATE ai_memories SET status = 'deleted', updated_at = now()
        WHERE location_id = $1 AND user_id = $2 AND id = $3 AND status = 'active'`,
      [locationId, userId, memoryId]
    );
    return r.rowCount > 0;
  });
}

export async function deleteAllMemories(locationId, userId) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `UPDATE ai_memories SET status = 'deleted', updated_at = now()
        WHERE location_id = $1 AND user_id = $2 AND status = 'active'`,
      [locationId, userId]
    );
    return r.rowCount;
  });
}

// For the ask/portfolio-ask prompts — plain content strings, oldest first,
// so an instruction given weeks ago and one given today read as accumulated
// context rather than the model favouring whichever the loop happens to
// see first.
export async function memoriesForPrompt(locationId, userId) {
  if (!userId) return [];
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `SELECT content FROM ai_memories
        WHERE location_id = $1 AND user_id = $2 AND status = 'active'
        ORDER BY created_at ASC`,
      [locationId, userId]
    );
    return r.rows.map((row) => row.content);
  });
}
