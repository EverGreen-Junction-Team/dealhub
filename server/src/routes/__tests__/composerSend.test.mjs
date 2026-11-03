// The Deal Hub composer's send route — POST /api/deals/:id/messages.
//
// Run: node src/routes/__tests__/composerSend.test.mjs
//
// Source-level, like dealRouteOrder: the route needs a database and GHL to run
// for real, so these pin the rules that keep it safe — what it checks before a
// message reaches a customer, and how the sent message finds its way back onto
// the deal it was sent from.

import { readFileSync } from 'node:fs';

const deals = readFileSync(new URL('../deals.js', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../../services/attributionEngine.js', import.meta.url), 'utf8');
const pending = readFileSync(new URL('../../services/pendingDealLink.js', import.meta.url), 'utf8');

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

const start = deals.indexOf("dealsRouter.post('/:id/messages'");
const route = deals.slice(start, deals.indexOf('\n});', start));

t('the route exists', start > -1);
t('only the three composable channels are accepted',
  /const DND_COLUMN = \{ Email: 'dnd_email', SMS: 'dnd_sms', WhatsApp: 'dnd_whatsapp' \}/.test(deals));
const onDealSql = deals.slice(deals.indexOf('const CONTACT_ON_DEAL_SQL'), deals.indexOf('const uploadAttachments'));
t('the recipient must be on THIS deal, primary or additional',
  /o\.contact_id = \$3/.test(onDealSql) && /opportunity_contacts oc/.test(onDealSql)
  && /client\.query\(CONTACT_ON_DEAL_SQL/.test(route));
t('attachments are passed through to the send', /attachments: body\.attachments/.test(route));

const upStart = deals.indexOf("'/:id/messages/attachments'");
const upload = deals.slice(upStart, deals.indexOf("dealsRouter.post('/:id/messages'", upStart));
t('the attachment route exists', upStart > -1);
t('an upload is for someone on THIS deal', /CONTACT_ON_DEAL_SQL/.test(upload));
t('an upload refuses an inactive install', /getActiveInstall/.test(upload));
t("multer's limit errors get rep-facing wording",
  /LIMIT_FILE_SIZE/.test(upload) && /LIMIT_FILE_COUNT/.test(upload));
t('DND is checked before the send', route.indexOf('dnd_channel') > -1
  && route.indexOf('dnd_channel') < route.indexOf('sendGhlMessage('));
t('a reply reads its thread from our own messages, not the request',
  /SELECT message_id, thread_id, subject\s+FROM messages/.test(route)
  && /threadId: reply\?\.thread_id/.test(route));
t('an inactive install is refused before sending',
  route.indexOf('getActiveInstall') > -1 && route.indexOf('getActiveInstall') < route.indexOf('sendGhlMessage('));
t('CC and BCC are passed through', /emailCc: body\.emailCc/.test(route) && /emailBcc: body\.emailBcc/.test(route));
t('the deal is parked for the webhook, for both ids',
  /sent\.messageId, sent\.emailMessageId/.test(route) && /ENTITY_MESSAGE, id, opportunityId/.test(route));
t('a webhook that beat the response is re-attributed', /detectedVia: 'composer'/.test(route));
t('write errors keep their own status and wording',
  /err instanceof MessageWriteError/.test(route));

t('messages are a pending-link entity', /ENTITY_MESSAGE = 'message'/.test(pending)
  && /new Set\(\[ENTITY_NOTE, ENTITY_TASK, ENTITY_MESSAGE\]\)/.test(pending));
const attr = engine.slice(engine.indexOf('export async function attributeMessage'));
t('the composer pick wins over the rule',
  attr.indexOf('consumePendingDealLink') > -1
  && attr.indexOf('consumePendingDealLink') < attr.indexOf('resolveOppForContact('));
t('a manual move still outranks the composer pick',
  attr.indexOf('hasManualMapping') < attr.indexOf('consumePendingDealLink'));
t('a composer send is "mapped", not "Moved"',
  /mappingStatus: 'mapped',\s*\n\s*rule: COMPOSER_RULE/.test(engine));
t('a re-sync cannot move a composer send',
  /mapping_status = 'manually_resolved' OR rule = '\$\{COMPOSER_RULE\}'/.test(engine));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
