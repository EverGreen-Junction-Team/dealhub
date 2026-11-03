// syncTasks.js — run tasksSync end-to-end.
//
// GHL has no TaskUpdate webhook, so an edit made in GHL to a task's title,
// body, due date or assignee reaches us ONLY through this sweep. Run it on the
// same nightly schedule as the other syncs.
//
//   npm run sync:tasks

import { syncAllTasks } from '../services/tasksSync.js';
import { logger } from '../utils/logger.js';

syncAllTasks()
  .then(() => {
    logger.info('syncTasks: done');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'syncTasks: failed');
    process.exit(1);
  });
