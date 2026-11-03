// skillTools.js — saved skills, presented to the model as ordinary tools.
//
// The model must not be able to tell a skill from a built-in tool. Same shape
// (name, description, input_schema), same result envelope, same error
// handling — so nothing in the prompt or the tool loop needs to know skills
// exist. That is the whole design: a skill is a new tool, not a new mechanism.
//
// Names are prefixed `skill_` for one reason only: a saved skill called
// `search_deals` would otherwise shadow the built-in one, and the model would
// get two tools with the same name and different behaviour. The prefix is
// stripped nowhere — it is the tool's real name.

import { listSkills, runSkill } from '../skillStore.js';
import { logger } from '../../../utils/logger.js';

const PREFIX = 'skill_';

const TYPE_MAP = { text: 'string', int: 'integer', number: 'number', bool: 'boolean', date: 'string' };

function toTool(skill) {
  const properties = {};
  for (const p of skill.params || []) {
    properties[p.name] = {
      type: p.op === 'in' ? 'array' : (TYPE_MAP[p.type] || 'string'),
      description: p.description || undefined,
      ...(p.op === 'in' ? { items: { type: TYPE_MAP[p.type] || 'string' } } : {}),
      ...(p.type === 'date' ? { format: 'date' } : {})
    };
  }
  return {
    name: `${PREFIX}${skill.name}`,
    // Appending the source is deliberate. Two skills built on different views
    // can read almost identically from their descriptions alone, and the model
    // picks between them on this text.
    description: `${skill.description} (Reads: ${skill.viewName}.)`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties
      // No `required`. Every parameter is a filter, and omitting one means
      // "don't filter on it" — which is how a model asks for everything.
    }
  };
}

/**
 * The enabled skills for a surface, as tool definitions.
 * Never throws: a broken skills table must not take the AI down with it.
 */
export async function skillToolsFor(locationId, surface) {
  try {
    const skills = await listSkills(locationId, { enabledOnly: true, surface });
    return skills.map(toTool);
  } catch (err) {
    logger.error({ err, locationId, surface }, 'skillTools: could not load skills');
    return [];
  }
}

export function isSkillTool(name) {
  return typeof name === 'string' && name.startsWith(PREFIX);
}

/**
 * Run a skill tool by its prefixed name. Returns the same { error } envelope
 * a built-in tool does on failure, so the loop handles both identically.
 */
export async function runSkillTool(locationId, name, args, surface) {
  const bare = name.slice(PREFIX.length);
  const skills = await listSkills(locationId, { enabledOnly: true, surface });
  const skill = skills.find((s) => s.name === bare);
  if (!skill) {
    // Disabled or deleted mid-conversation, or the model invented a name.
    return { error: `No skill named "${bare}" is available here.` };
  }
  return runSkill(locationId, skill, args || {});
}
