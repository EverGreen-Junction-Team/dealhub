// providers.js — the conversation-provider catalogue the composer reads.
//
// A location can run GHL's NATIVE channel and a CUSTOM marketplace provider
// that shares its name. A real account shows exactly this: native WhatsApp
// alongside a provider named "WhatsApp QR", plus "iMessage" and "SMS Android"
// all sitting under type SMS.
//
// That matters because sending `{ type: 'WhatsApp' }` with no provider id
// lets GHL route through whichever provider it considers default. The rep
// had no way to choose and the timeline had no way to say which one carried
// the message. So this endpoint returns, per channel, every provider the rep
// could send through — with the ones whose names collide flagged, because a
// picker should only interrupt someone when there is a genuine choice to make.
//
// Read-only. The catalogue is written by conversationProvidersSync.

import express from 'express';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { logger } from '../utils/logger.js';
import { senderChannel } from '../utils/channels.js';
import { mailboxForUser } from '../services/userWriter.js';

export const providersRouter = express.Router();
providersRouter.use(requireSession);

// Channels a rep can actually compose a message for in this app. The
// catalogue stores more (Call providers, for instance) and the Settings view
// shows all of them — but offering to "send" through a Voice provider would
// be a compose UI we do not have. See ghlMessageWrite's ALLOWED_TYPES, which
// this deliberately mirrors.
const COMPOSABLE = new Set(['SMS', 'Email', 'WhatsApp']);

// GHL's native sender for a channel is not a row in the provider list — it is
// the implicit default you get by sending `type` alone. We surface it as a
// first-class option so the picker can offer "Native" vs a named provider as
// a real choice rather than "pick a provider, or don't".
function nativeOption(channel) {
  return {
    id: null,                 // null id == send `type` with no provider id
    name: `${channel} (native)`,
    shortName: 'Native',
    channel,
    isNative: true,
    isDefault: false,         // recomputed below
    isDeleted: false
  };
}

providersRouter.get('/', async (req, res) => {
  const locationId = req.locationId;
  const includeDeleted = req.query.includeDeleted === 'true';
  // The composer wants only what it can send through; Settings wants all.
  const scope = req.query.scope === 'all' ? 'all' : 'composable';

  try {
    const rows = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT provider_id, name, type, is_default, is_native,
                is_deleted, last_synced_at
           FROM conversation_providers
          WHERE location_id = $1
            AND ($2::boolean OR is_deleted = false)
          ORDER BY type, is_default DESC, lower(COALESCE(name, '')), provider_id`,
        [locationId, includeDeleted]
      );
      return rows;
    });

    const channels = {};
    for (const r of rows) {
      // senderChannel, not r.type — see utils/channels. WhatsApp QR belongs
      // in the WhatsApp group, or the card's picker finds one WhatsApp sender
      // and hides itself.
      const channel = senderChannel(r) || 'Unknown';
      if (scope === 'composable' && !COMPOSABLE.has(channel)) continue;
      (channels[channel] ||= []).push({
        id: r.provider_id,
        name: r.name || 'Unnamed provider',
        shortName: r.name || 'Unnamed provider',
        channel,
        isNative: r.is_native,
        isDefault: r.is_default,
        isDeleted: r.is_deleted,
        lastSyncedAt: r.last_synced_at
      });
    }

    // Every composable channel gets its native option, even one with no
    // custom providers at all — otherwise a location using only native SMS
    // would see an empty list and think the channel was unavailable.
    if (scope === 'composable') {
      for (const channel of COMPOSABLE) (channels[channel] ||= []);
      // THE REP'S OWN MAILBOX, when they have two-way sync connected. A
      // per-USER sender, not a location one: it comes from users.two_way_sync
      // for the signed-in user, and sends through GHL's `emailFrom`. The
      // synthetic id is what ghlMessageWrite recognises.
      const userId = req.session?.userId || null;
      if (userId) {
        // By user across the company, not by this location's row — see
        // mailboxForUser.
        const box = await mailboxForUser(locationId, userId);
        if (box) {
          const { email: mail, kind } = box;
          channels.Email.push({
            id: `emailfrom:${mail}`,
            name: `${kind} · ${mail}`,
            shortName: kind,
            channel: 'Email',
            isNative: false,
            isDefault: false,
            isDeleted: false,
            emailFrom: mail,
            lastSyncedAt: null
          });
        }
      }
    }

    const out = Object.entries(channels).map(([channel, providers]) => {
      const list = COMPOSABLE.has(channel)
        ? [nativeOption(channel), ...providers]
        : providers;

      // If GHL marked no provider as default, the native sender is what a
      // bare `type` send would use — so that is the honest default to show.
      if (COMPOSABLE.has(channel) && !list.some((p) => p.isDefault)) {
        const native = list.find((p) => p.id === null);
        if (native) native.isDefault = true;
      }

      // A collision is what makes the picker necessary. Compare on the name a
      // rep actually reads, case- and space-insensitively, because "WhatsApp"
      // and "Whatsapp " are the same word to the person choosing. The channel
      // name itself counts: a provider literally named "WhatsApp" on the
      // WhatsApp channel is indistinguishable from native in the timeline.
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const counts = {};
      for (const p of list) {
        const key = p.id === null ? norm(channel) : norm(p.name);
        counts[key] = (counts[key] || 0) + 1;
      }
      for (const p of list) {
        const key = p.id === null ? norm(channel) : norm(p.name);
        p.ambiguous = counts[key] > 1;
      }

      return {
        channel,
        providers: list,
        // The composer uses this to decide whether to show a picker at all.
        hasChoice: list.filter((p) => !p.isDeleted).length > 1,
        hasCollision: list.some((p) => p.ambiguous)
      };
    });

    // Composable channels first and in compose order, then the rest
    // alphabetically — Settings reads the same payload.
    const order = ['SMS', 'Email', 'WhatsApp'];
    out.sort((a, b) => {
      const ai = order.indexOf(a.channel), bi = order.indexOf(b.channel);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.channel.localeCompare(b.channel);
    });

    res.json({ channels: out });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/providers failed');
    res.status(500).json({ error: 'Could not load the sender list' });
  }
});
