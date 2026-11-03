// propose_send_message must only reach someone ON the deal it was asked from.
//
// This is the one proposed action that reaches a CUSTOMER, and the model picks
// the contact id itself from whatever it read during the turn. Without a check,
// a question asked on deal A could propose a message to a contact seen while
// searching deal B — and the confirmation card would look normal, because it
// shows a name the model supplied.
//
// Three bugs had to be fixed together for this to work at all, and each would
// silently disable the feature on its own:
//   1. opportunityId was absent from the tool schema (additionalProperties:
//      false), so the model COULD NOT send it.
//   2. The deal's id was never in the prompt, so the model did not KNOW it.
//   3. No check existed, so any contact was accepted.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const registry = readFileSync(join(root, 'src/services/ai/tools/registry.js'), 'utf8');
const prompts  = readFileSync(join(root, 'src/services/ai/prompts.js'), 'utf8');

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// 1. The schema must accept opportunityId.
const sendTool = registry.slice(
  registry.indexOf("name: 'propose_send_message'"),
  registry.indexOf('run: proposeSendMessage')
);
t('propose_send_message accepts opportunityId', /opportunityId:\s*\{\s*type: 'string'/.test(sendTool));
t('the schema is still closed to unknown keys', /additionalProperties: false/.test(sendTool));
t('the description tells the model to scope to the deal',
  /get_deal_contacts/.test(sendTool));

// 2. The model must be given the deal id.
t('the deal id is in the thread block', /Deal id: \$\{d\.deal_id\}/.test(prompts));
t('the deal id line is omitted when absent (no "Deal id: undefined")',
  /d\.deal_id \? `Deal id/.test(prompts));

// 3. The check must exist and must not be a silent filter.
t('a deal-membership check exists', /contactIsOnDeal/.test(registry));
t('the check runs only when a deal was given', /if \(a\.opportunityId\) \{/.test(registry));
t('an off-deal recipient is WARNED about, not refused',
  /warning: 'This contact is not linked to this deal/.test(registry));
t('the proposal still goes through for an off-deal contact',
  /offDealContact \? \{/.test(registry) && !/needsInfo: \['which of this deal/.test(registry));
t('the detector tells the model to flag an off-deal contact',
  /isn't linked to this deal/.test(
    readFileSync(join(root, 'src/services/ai/dealActionDetector.js'), 'utf8')));
t('the detector forbids silently substituting the primary contact',
  /Never silently substitute the deal's primary contact/.test(
    readFileSync(join(root, 'src/services/ai/dealActionDetector.js'), 'utf8')));

// The membership query must accept the deal's OWN primary contact.
// opportunity_contacts is empty for a deal whose only person is the primary,
// because GHL fires RelationCreate only for ADDITIONAL contacts — checking
// that table alone would reject the obvious recipient on most deals.
const checkFn = registry.slice(
  registry.indexOf('async function contactIsOnDeal'),
  registry.indexOf('async function proposeSendMessage')
);
t('the check reads opportunity_contacts', /FROM opportunity_contacts/.test(checkFn));
t('the check ALSO accepts the deal\'s own primary contact', /FROM opportunities/.test(checkFn));
t('the two are UNIONed, not AND-ed', /UNION/.test(checkFn));
t('the check is tenant-scoped', /location_id = \$1/.test(checkFn));

// Simulate the membership logic.
const isOnDeal = (relations, primaryOf, dealId, contactId) =>
  relations.some((r) => r.dealId === dealId && r.contactId === contactId) ||
  primaryOf[dealId] === contactId;

const relations = [{ dealId: 'A', contactId: 'c2' }];
const primary = { A: 'c1', B: 'c9' };

t('the deal\'s primary contact is allowed', isOnDeal(relations, primary, 'A', 'c1'));
t('an additional linked contact is allowed', isOnDeal(relations, primary, 'A', 'c2'));
// Membership now decides whether to WARN, not whether to allow.
t('a contact from ANOTHER deal is flagged as off-deal', !isOnDeal(relations, primary, 'A', 'c9'));
t('an unrelated contact is flagged as off-deal', !isOnDeal(relations, primary, 'A', 'c404'));
t('a contact on the deal raises no warning', isOnDeal(relations, primary, 'A', 'c1'));

// ── Deal AI: action detection on a CACHED answer ─────────────────────
// The reported failure. A rep asked Deal AI "can you create a task for me?",
// had asked the same words before, and the cache served the old READ-ONLY
// answer — "there is no record that a task titled ... was created". No card,
// no proposal. The same request on Insights AI proposed the task correctly,
// which is why Deal AI looked worse: its write path was never consulted.
const askDeal = readFileSync(join(root, 'src/services/ai/askDeal.js'), 'utf8');
const cacheBlock = askDeal.slice(
  askDeal.indexOf('if (hit?.validated_output)'),
  askDeal.indexOf('logContextSize') > 0 ? askDeal.indexOf('const result') : askDeal.length
);

t('a cached answer no longer returns an empty proposedActions',
  !/proposedActions: \[\],/.test(cacheBlock));
t('the detector runs on the cache-hit path',
  /detectDealAction\(/.test(cacheBlock));
t('proposals found on a cache hit are linked to the run',
  /linkActionsToRun/.test(cacheBlock));
t('a detector failure does not lose the cached answer',
  /catch \(err\)/.test(cacheBlock) && /answer still served/.test(cacheBlock));
t('the detector note is appended to the cached answer text',
  /cachedNote/.test(cacheBlock));
t('the cached ANSWER is still reused (only detection re-runs)',
  /\.\.\.cachedOutput/.test(cacheBlock));

// ── The warning must LEAD the reply, not trail it ────────────────────
// "Mention it afterwards" is not a safeguard. A rep skimming the first line
// is exactly the person about to click Confirm on a message to the wrong
// customer, so the mismatch has to be the first thing in the sentence.
t('the send warning tells the model to open with the mismatch',
  /Open your reply with that fact before anything else/.test(registry));
t('the send warning forbids leading with the draft',
  /Do not lead with what you drafted/.test(registry));
t('the detector rule says LEAD WITH IT',
  /LEAD WITH IT/.test(readFileSync(join(root, 'src/services/ai/dealActionDetector.js'), 'utf8')));

// create_task had NO deal check at all — the originally reported failure was
// a TASK addressed to the wrong contact, not a message.
const taskFn = registry.slice(
  registry.indexOf('async function proposeCreateTask'),
  registry.indexOf('async function proposeCompleteTask')
);
t('create_task checks deal membership', /contactIsOnDeal/.test(taskFn));
t('create_task warns rather than blocking', /warning: 'This contact is not linked/.test(taskFn));
t('the task warning also leads', /Open your reply with that fact/.test(taskFn));
t('create_task still proposes for an off-deal contact',
  /offDealContact \? \{/.test(taskFn) && !/needsInfo: \['which of this deal/.test(taskFn));

// ── Every return path must check for a write action ──────────────────
// Three ways out of askDeal, and TWO of them used to return proposedActions: []
// flat. A rep saw the AI answer a "send a message" request with prose and no
// card, which reads as a refusal:
//   - cache hit      → fixed earlier
//   - empty thread   → this one. A deal with no conversation yet is exactly
//                      when a rep is most likely to be starting one.
const paths = askDeal.split('proposedActions');
t('no return path hardcodes an empty proposedActions',
  !/proposedActions: \[\]\s*$/m.test(askDeal) && !/proposedActions: \[\],/.test(askDeal));
t('the empty-thread path runs the detector',
  /action detection failed on an empty thread/.test(askDeal));
t('the empty-thread path returns what it found',
  /proposedActions: emptyActions/.test(askDeal));
t('the cache path returns what it found',
  /proposedActions: cachedActions/.test(askDeal));
t('an empty-thread detector failure still serves the answer',
  /emptyActions = \[\]/.test(askDeal) && /catch \(err\)/.test(askDeal));
// A draft ANSWERS the question, so "nothing to read" is not a useful second
// half — it is dropped entirely rather than appended.
t('a draft on an empty thread replaces the "nothing to read" line',
  /answerText: emptyNote \|\| base/.test(askDeal));

// ── Tasks are evidence, so they must defeat the empty-thread guard ───
// The guard checked messages and notes only. A deal whose entire evidence is
// tasks answered "there is nothing to read" — printed directly beside a rail
// showing two tasks. Rule 7 of the system prompt calls tasks first-class
// citable evidence and promptBlock renders them; only the guard disagreed.
t('the empty-thread guard counts tasks',
  /ctx\.tasks\?\.length \?\? 0\) === 0/.test(askDeal));
t('the guard still requires messages to be empty',
  /ctx\.messages\.length === 0/.test(askDeal));
t('the guard still requires notes to be empty',
  /ctx\.notes\.length === 0/.test(askDeal));
t('the empty copy names tasks too',
  /no messages, notes or tasks on this deal/.test(askDeal));
t('the old message-and-note-only copy is gone',
  !/no readable messages or notes on this deal/.test(askDeal));

// The prompt side was always right — this pins it so the two cannot drift.
const promptsSrc = readFileSync(join(root, 'src/services/ai/prompts.js'), 'utf8');
t('tasks are rendered into the prompt as citable evidence',
  /Tasks our team recorded \(citable evidence\)/.test(promptsSrc));

// ── Every answer must land in Recents ────────────────────────────────
// The sidebar is built from ai_runs (runLog.askHistory). Two of the three
// return paths never called recordRun, so a rep got an answer on screen that
// was missing from Recents and gone entirely after a refresh:
//   - cache hit    → returned the ORIGINAL run's id, wrote no new row
//   - empty thread → returned runId: null
t('the cache path records a run', /cachedRunId = await recordRun/.test(askDeal));
t('the empty-thread path records a run', /emptyRunId = await recordRun/.test(askDeal));
t('no path returns a null runId any more', !/runId: null,/.test(askDeal));
// `hit.id` still appears as a log field and as the fallback when recordRun
// fails — both correct. What matters is the RETURNED runId.
t('the cache path returns its OWN run id, not the original',
  /runId: cachedRunId/.test(askDeal));

// A recorded cache-hit row must never become a cache entry itself, or one
// cached answer would seed the next.
const cacheRecord = askDeal.slice(
  askDeal.indexOf('cachedRunId = await recordRun'),
  askDeal.indexOf('proposedActions: cachedActions'));
t('the cache-hit row is not itself cacheable', /cacheKey: null/.test(cacheRecord));

// recordRun reads coverage from run.coverage, not flat fields — passing them
// flat writes three NULLs and a reopened chat shows "Read null of null".
t('the cache path nests coverage correctly', /coverage: \{/.test(cacheRecord));

// Every recorded row must satisfy askHistory's WHERE clause or it is invisible.
for (const field of ['callType', 'conversationId', 'validatedOutput']) {
  t(`the cache row sets ${field} (askHistory filters on it)`,
    new RegExp(`${field}:`).test(cacheRecord));
}
// `question` is passed as ES6 shorthand, so it has no trailing colon.
t('the cache row sets question (askHistory filters on it)',
  /^\s*question,\s*$/m.test(cacheRecord));

// ── The answer call must not speak for the write path ────────────────
// Two model calls see one turn. The answer call reads the thread and knows
// nothing about the detector, so on "send them a message" it reasoned from the
// thread alone and refused — "there is nothing in this deal's record that lets
// me send a message, use the CRM's messaging tool directly" — with the
// detector's "I can draft an SMS, what should it say?" appended underneath.
// A rep read a refusal followed by an offer, in one answer.
//
// THE FIX FOR THAT HAS BEEN REPLACED. It was to tell the answer call that a
// write request was "NOT your job and is handled separately", and to reply
// "Working on that." so the detector's sentence could be swapped in. Since
// the port to the tool loop there is no separate step: the model holds
// propose_send_message itself. Leaving that instruction in place meant a rep
// asking "draft a message" got back the literal words "Working on that." and
// no draft — the handoff it was waiting for no longer existed.
//
// So the assertion is inverted: the prompt must now CLAIM the write request,
// not defer it. The three rules below it are unchanged and still hold — they
// are about never refusing and never deflecting to the CRM, which matters
// just as much when the model does the work itself.
t('the answer prompt claims write requests rather than deferring them',
  /IS your job/.test(askDeal) && !/is NOT your job and is handled separately/.test(askDeal));
// Messaging is the exception since the timeline composer: on a deal the
// answer call does not draft a message — it points to the composer.
t('the answer prompt does not offer the message tool on a deal',
  !/call propose_send_message/.test(askDeal));
t('the answer prompt points message requests to the composer',
  /The ONE exception is messaging a customer/.test(askDeal) && askDeal.includes('${COMPOSER_POINTER}'));
t('the answer prompt forbids claiming a CRM action cannot be done',
  /Never say such a request cannot be done/.test(askDeal));
t('the answer prompt forbids sending reps to the CRM',
  /never tell the rep to use the CRM directly/.test(askDeal));
t('the placeholder is swapped out, not shown',
  /PLACEHOLDER\.test/.test(askDeal) && /mergeAnswerAndNote/.test(askDeal));
t('all three paths share one merge helper',
  (askDeal.match(/mergeAnswerAndNote\(/g) || []).length >= 3);
t('a real answer still keeps the detector note appended',
  /\$\{answerText\}\\n\\n\$\{note\}/.test(askDeal));

// ── An unnamed channel is asked about, not guessed ───────────────────
// "send a message" names no channel. The rule fell through to "prefer SMS if a
// phone number is present", so the reply announced "I can draft an SMS" on a
// deal whose entire conversation is WhatsApp — a guess, and the wrong one. The
// rep only finds out after confirming, when it leaves from another number.
const detector = readFileSync(join(root, 'src/services/ai/dealActionDetector.js'), 'utf8');
// ── The detector never drafts a message on a deal ────────────────────
// Since the timeline composer, messaging a customer is the rep's own job on a
// deal. The detector's channel-picking rules went with propose_send_message.
t('the detector withholds propose_send_message',
  detector.includes('.filter((n) => !DEAL_HUB_NO_SEND_TOOLS.has(n))'));
t('the detector is told messaging is not its job here',
  /MESSAGING A CUSTOMER IS NOT YOURS HERE/.test(detector));
t('a mixed request still gets its CRM action', /do only the CRM action/.test(detector));
t('the channel-picking rules are gone',
  !/Choosing SMS vs WhatsApp vs Email for propose_send_message/.test(detector)
  && !/GROUP EMAILS/.test(detector));
t('the detector is told which channels the deal uses', /function channelBlock/.test(detector));
// The prompt is assembled from an array now, not a template string, so the
// blocks can be conditional — providersBlock returns '' when there is no
// choice to offer, and filter(Boolean) drops it.
t('channelBlock is in the system prompt', /channelBlock\(messages, providerNames\)/.test(detector));
t('providersBlock is in the system prompt', /providersBlock\(provRows\)/.test(detector));
t('an empty block is dropped, not printed blank', /\.filter\(Boolean\)\.join/.test(detector));
t('tasks and notes are not mistaken for channels',
  /c === 'NOTE' \|\| c === 'TASK'/.test(detector));
t('every askDeal path passes messages to the detector',
  (askDeal.match(/messages: ctx\.messages/g) || []).length === 3);

// ── The channel offer must match what the contact can receive ────────
// The contact block listed "email" and "phone" as raw facts and left the model
// to infer the channel list. It inferred "SMS or Email" — dropping WhatsApp,
// which rides the same phone number — and offered exactly that on a deal whose
// entire conversation is WhatsApp.
t('receivable channels are stated, not inferred', /function channelsFor/.test(detector));
t('the contact block carries the can-receive list', /can receive: /.test(detector));
t('WhatsApp is offered whenever a phone exists',
  /p\.phone && !dnd\.all && !dnd\.whatsapp/.test(detector));
t('DND removes a channel from the offer, rather than being a separate caveat',
  /!dnd\.text/.test(detector) && /!dnd\.email/.test(detector));

const channelsForFn = detector.slice(
  detector.indexOf('function channelsFor'), detector.indexOf('function contactsBlock'));
t('no channel is offered without the detail it needs',
  /p\.phone &&/.test(channelsForFn) && /p\.email &&/.test(channelsForFn));

// ── A reply continues the thread's own sender ────────────────────────
// A location can run native WhatsApp beside a "WhatsApp QR" provider. Replying
// from the wrong one reaches the customer as a NEW conversation from a number
// they do not recognise — so the thread's own sender is the right default, and
// the rep can still change it on the card.
const ctxBuilder = readFileSync(join(root, 'src/services/ai/contextBuilder.js'), 'utf8');
t('the send tool accepts a provider id',
  /conversationProviderId: \{ type: 'string'/.test(registry));
t('the proposed payload carries it through to the card',
  /conversationProviderId: a\.conversationProviderId \|\| null/.test(registry));
// The apostrophe is backslash-escaped in the source string.
t('the tool tells the model to reuse the thread\'s sender',
  /the one the deal..s existing thread already uses/.test(registry));
// The channel type stays real; ghlMessageWrite rewrites it to 'Custom' for a
// marketplace sender. The model must not try to do that itself.
t('the model is told to keep the real channel type',
  /Keep `type` as the real channel/.test(registry));
t('messages carry their provider id', /m\.conversation_provider_id/.test(ctxBuilder));
t('the shaped message exposes it',
  /conversation_provider_id: row\.conversation_provider_id/.test(ctxBuilder));
t('the detector names the sender per channel', /last sent via/.test(detector));
t('provider ids are resolved to names', /function resolveProviderNames/.test(detector));
t('an unresolvable name still yields a usable id',
  /\$\{name \? `\$\{name\}, ` : ''\}/.test(detector));
t('name resolution failing is non-fatal',
  /could not resolve provider names/.test(detector));
// The sentence is split across a string concatenation, so join the pieces
// the way the model will actually receive them before matching.
t('the model is told to pass the same id back',
  /pass that same id so the reply continues the existing conversation/
    .test(detector.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ')));

// ── No id ever reaches the screen ────────────────────────────────────
// The model is handed conversationProviderIds so it can pass one back as a
// tool argument. The nearest thing to hand when writing a sentence about a
// sender is that same id, so "I'll send via 6a22bfc4..." is one slip away.
t('the prompt forbids ids in the reply', /NEVER put an id in your reply/.test(detector));
t('the prompt says reps read names', /The rep reads names/.test(detector));
t('a stripper backs up the prompt rule', /function stripIds/.test(detector));
t('the note is stripped before it is returned', /note: stripIds\(/.test(detector));

const ID_SHAPES = /\b([0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
function stripIds(text) {
  if (!text) return text;
  if (!ID_SHAPES.test(text)) { ID_SHAPES.lastIndex = 0; return text; }
  ID_SHAPES.lastIndex = 0;
  const cleaned = text.replace(ID_SHAPES, '')
    .replace(/\(\s*[,;]?\s*\)/g, '').replace(/\s*,\s*(?=[,.)])/g, '')
    .replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
  return cleaned || null;
}
const hasId = (t) => { const r = ID_SHAPES.test(t || ''); ID_SHAPES.lastIndex = 0; return r; };

t('a Mongo ObjectId is removed', !hasId(stripIds('Sending via 6a22bfc4fcbd457e97784fbb now.')));
t('a UUID is removed', !hasId(stripIds('Run 0a18c155-6fb9-4761-8605-d47ac4b3eb32 done.')));
t('an id in parentheses leaves no empty brackets',
  stripIds('via WhatsApp QR (6a22bfc4fcbd457e97784fbb).') === 'via WhatsApp QR.');
t('clean prose is untouched',
  stripIds('I have drafted a WhatsApp to bindu via WhatsApp QR.')
    === 'I have drafted a WhatsApp to bindu via WhatsApp QR.');
t('a phone number is not mistaken for an id',
  stripIds('Call bindu on +919502803691 tomorrow.') === 'Call bindu on +919502803691 tomorrow.');
t('dates and ordinary words survive',
  stripIds('Due 21 Sep 2026, task dsfgs is overdue.') === 'Due 21 Sep 2026, task dsfgs is overdue.');
t('the real question is unaffected',
  stripIds('What should it say, and WhatsApp or SMS?') === 'What should it say, and WhatsApp or SMS?');
t('null in, null out', stripIds(null) === null);

// ── Senders, not just channels ───────────────────────────────────────
// The detector learned providers only from the THREAD's messages, so on a
// deal with no messages it knew none — exactly when a rep is most likely to
// be starting a conversation. It asked "SMS, WhatsApp or Email?" without
// mentioning that SMS has three senders behind it.
t('the location\'s senders are listed, not only the thread\'s',
  /async function locationProviders/.test(detector));
t('only channels this app can compose for', /COMPOSABLE_TYPES/.test(detector));
// Reversed deliberately. Listing only channels with MORE than one sender
// dropped every native sender (not a row in conversation_providers) and any
// channel whose only sender was one custom one — so an account with three
// custom SMS senders was offered those three and never told email existed.
t('every composable channel is listed, native sender included',
  /COMPOSABLE_TYPES\.map\(\(type\) =>/.test(detector)
  && /\$\{type\} \(native\)/.test(detector));
t('a channel with only its native sender does not force a choice',
  /do not\s*'\s*\+\s*'\s*make the rep choose|do not make the rep choose/
    .test(detector.replace(/\n\s*/g, ' ')));
t('deleted providers are excluded', /is_deleted = false/.test(detector));
t('the default sender is marked', /is_default \? ' \(default\)' : ''/.test(detector));
t('the model is told to name senders, never ids',
  /Name senders, never ids/.test(detector));
// The sentence is split across a string concatenation, so join the pieces
// the way the model receives them before matching.
t('an existing thread still wins over the location list',
  /A thread that already has messages overrides all of this/
    .test(detector.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ')));
t('a failed provider lookup is non-fatal', /could not list providers/.test(detector));

// ── Every deals table row needs a contact ────────────────────────────
// The UI renders any tool returning `deals` in one shared table
// (AnswerDealsTable), which has a CONTACT column. Two tools —
// get_qualification_gaps and get_lost_won_breakdown — returned deals with no
// contact column at all, so a deal that plainly has one showed a dash: the
// row looked broken rather than sparse.
//
// Checked structurally, not by name, so a NEW deals-returning tool cannot
// reintroduce it quietly.
const dealsReturns = [...registry.matchAll(/return \{ deals:/g)].map((m) => m.index);
t('there are deals-returning tools to check', dealsReturns.length >= 3);
for (const idx of dealsReturns) {
  // The query that feeds this return: back up to its SELECT.
  const before = registry.slice(Math.max(0, idx - 3500), idx);
  const selectAt = before.lastIndexOf('`SELECT');
  const query = selectAt === -1 ? before : before.slice(selectAt);
  const fnAt = registry.slice(0, idx).lastIndexOf('async function ');
  const fnName = registry.slice(fnAt, idx).match(/async function (\w+)/)?.[1] || '(unknown)';
  t(`${fnName} selects a contact for the deals table`, /AS contact\b/.test(query));
  t(`${fnName} joins contacts on the deal's own contact_id`,
    /LEFT JOIN contacts ct/.test(query));
  // A deal has ONE primary contact plus any number of additional ones. The
  // table names the primary and counts the rest — showing one name on a deal
  // with three people reads as a deal with one.
  t(`${fnName} counts the deal's additional contacts`,
    /otherContactsSql\('o'\)/.test(query));
}

// The count must exclude the primary. GHL writes a relation row for the
// primary too, so counting every opportunity_contacts row would report a
// one-contact deal as having one extra person.
const otherFn = registry.slice(
  registry.indexOf('const otherContactsSql'),
  registry.indexOf('const contactLabelSql'));
t('the additional-contact count excludes the primary flag',
  /oc\.is_primary\s+= false/.test(otherFn));
t('it also excludes the primary by id',
  /oc\.contact_id\s+<> \$\{o\}\.contact_id/.test(otherFn));
t('it is tenant-scoped', /oc\.location_id\s+= \$\{o\}\.location_id/.test(otherFn));

// ── Primary vs additional contact ────────────────────────────────────
// A deal has ONE primary (opportunities.contact_id, NOT NULL) and any number
// of additional people in opportunity_contacts. Messaging the architect
// instead of the customer is routine work — but "To pra" and "To bindu" read
// identically on the card, and only one is who a rep would assume.
t('the membership check reports WHICH kind of contact',
  /is_primary\s+FROM opportunities/.test(registry.replace(/\s+/g, ' ')));
t('it prefers the primary when a contact is both',
  /ORDER BY is_primary DESC/.test(registry));
t('it returns a shape, not a bare boolean',
  /onDeal: true, isPrimary: rows\[0\]\.is_primary/.test(registry));
t('both callers were updated for the new shape',
  (registry.match(/offDealContact = !on\.onDeal/g) || []).length === 2);
t('send proposals carry the flag',
  /isAdditionalContact: additionalContact \|\| undefined/.test(registry));
t('task proposals carry it too',
  (registry.match(/isAdditionalContact: additionalContact/g) || []).length === 2);

// Guarded with existsSync: production runs a server-only clone, and an
// unguarded read fails the whole suite (see crossRepoReads.test.mjs). The
// skip is announced, because a silent one looks identical to a pass.
const dashCard = join(root, '..', '..', 'pipelinePulse-dashboard',
  'src/pages/shared/ActionCard.jsx');
if (!existsSync(dashCard)) {
  console.log('  (dashboard not checked out — skipping the ActionCard assertions)');
} else {
  const card = readFileSync(dashCard, 'utf8');
  t('the card has a tag for it', /function AdditionalContactTag/.test(card));
  t('the tag is silent for a primary contact', /if \(!on\) return null/.test(card));
  t('it reads as information, not a warning', /not the main contact/.test(card));
  t('it appears on both the message and task cards',
    (card.match(/<AdditionalContactTag/g) || []).length >= 2);
}

// Native senders reach Insights AI too — same gap existed in the portfolio
// tool, which returned only the custom rows.
t('the portfolio tool returns a per-channel sender list',
  /channels: COMPOSABLE\.map/.test(registry));
t('each channel leads with its native sender',
  /name: `\$\{type\} \(native\)`, conversationProviderId: null/.test(registry));
t('the tool description says a native sender has no id',
  /A native sender has no id/.test(registry));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL: ${f}`); process.exit(1); }
