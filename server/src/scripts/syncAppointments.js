// syncAppointments.js — run appointmentsSync end-to-end.
//
// The nightly sweep, on demand. Two reasons to reach for it rather than
// waiting for 3am:
//
//   BLOCKED TIME HAS NO WEBHOOK. GHL fires nothing when somebody blocks an
//   hour out of a calendar, so this sweep is its ONLY path into our
//   database. After granting the calendar scopes, this is how you find out
//   within a minute whether blocked time arrives, instead of the next
//   morning.
//
//   BACKFILL. A sub-account that has just been connected has an empty
//   appointments table and a diary going back months. This fills the window.
//
//   npm run sync:appointments

import { syncAllAppointments } from '../services/appointmentsSync.js';
import { logger } from '../utils/logger.js';

syncAllAppointments()
  .then(() => {
    logger.info('syncAppointments: done');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'syncAppointments: failed');
    process.exit(1);
  });
