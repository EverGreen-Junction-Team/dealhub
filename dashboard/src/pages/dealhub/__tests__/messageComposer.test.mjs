// The timeline composer — GHL's Conversations composer under the Deal Hub
// timeline.
//
// Run: node --test src/pages/dealhub/__tests__/messageComposer.test.mjs
//
// Source-level, like the other Deal Hub tests: the component needs a browser
// and the API to run. These pin the rules a rep relies on — which channels are
// offered, who can be sent to, and that Reply opens HERE rather than Co-Pilot.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../MessageComposer.jsx', import.meta.url), 'utf8')
const timeline = readFileSync(new URL('../Timeline.jsx', import.meta.url), 'utf8')
const tab = readFileSync(new URL('../../tabs/DealHubTab.jsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../../../api/deals.js', import.meta.url), 'utf8')

test('it sends through the deal route, not a Co-Pilot action', () => {
  assert.match(api, /sendMessage: \(id, payload\) =>\s*\n\s*apiClient\.post\(`\/api\/deals\/\$\{encodeURIComponent\(id\)\}\/messages`/)
  assert.match(src, /dealsAPI\.sendMessage\(dealId,/)
  assert.doesNotMatch(src, /aiAPI|confirmAction/)
})

test('Email is one channel; each SMS/WhatsApp sender is its own', () => {
  // GHL lists "WhatsApp QR", "SMS Android", "iMessage" as channels in their
  // own right, while Email's senders are a From choice.
  assert.match(src, /key: 'Email', channel: 'Email', providerId: null/)
  assert.match(src, /for \(const p of custom\) \{\s*\n\s*out\.push\(\{ key: `\$\{channel\}:\$\{p\.id\}`, channel, providerId: p\.id, label: p\.name/)
  // Native only when GHL has a native sender, or it is the only option.
  assert.match(src, /if \(nativeRow \|\| custom\.length === 0\)/)
})

test('a custom provider goes out as its channel plus its id', () => {
  assert.match(src, /conversationProviderId: isEmail \? \(from\?\.id \?\? null\) : option\.providerId/)
})

test('who cannot be sent to is said before Send, not after', () => {
  assert.match(src, /channel === 'Email' && !person\.email\) return 'This contact has no email address'/)
  assert.match(src, /channel !== 'Email' && !person\.phone\) return 'This contact has no phone number'/)
  assert.match(src, /person\.dnd\?\.all \|\| person\.dnd\?\.channels\?\.\[DND_KEY\[channel\]\]/)
  assert.match(src, /const canSend = !sending && !uploading && !blocked && !bodyEmpty/)
})

test('an email needs a subject; To/CC/BCC are chip lists with a contact dropdown', () => {
  assert.match(src, /\(mode === 'comment' \|\| !isEmail \|\| subject\.trim\(\)\)/)
  // GHL's composer: chips + dropdown for To, CC and BCC, CC/BCC behind links.
  assert.match(src, /<RecipientsField value=\{rcpt\} onChange=\{setRcpt\} options=\{dealOptions\} scope="all" collapsibleCc \/>/)
  // GHL takes ONE To: the first goes as emailTo, the rest of To join CC.
  assert.match(src, /emailTo: firstTo\.email/)
  assert.match(src, /emailCc: \[\.\.\.rcpt\.to\.slice\(1\), \.\.\.rcpt\.cc\]\.map\(\(r\) => r\.email\)/)
  assert.match(src, /emailBcc: rcpt\.bcc\.map\(\(r\) => r\.email\)/)
  // The first To is the conversation's contact, so it must be on this deal.
  assert.match(src, /The first To must be someone on this deal/)
  const rf = readFileSync(new URL('../../../components/RecipientsField.jsx', import.meta.url), 'utf8')
  assert.match(rf, /collapsibleCc = false/)
  assert.match(rf, /useState\(!collapsibleCc \|\| \(v\.cc \|\| \[\]\)\.length > 0\)/)
})

test('a reply is sent into its thread', () => {
  assert.match(src, /replyToMessageId: reply\?\.messageId \|\| undefined/)
  assert.match(src, /setSubject\(base \? `Re: \$\{base\}` : ''\)/)
})

test('an internal comment is a deal-linked note, never a send', () => {
  // GHL has no API for its own internal comments.
  const comment = src.slice(src.indexOf("if (mode === 'comment') {"), src.indexOf('} else {', src.indexOf("if (mode === 'comment') {")))
  assert.match(comment, /notesAPI\.create\(\{/)
  assert.match(comment, /opportunityId: dealId/)
  assert.doesNotMatch(comment, /sendMessage/)
})

test('the signature is added once', () => {
  assert.match(src, /isEmail && signature && !bodyHtml\.includes\(signature\)/)
})

test('Reply opens a composer INSIDE the thread card, not at the foot or in Co-Pilot', () => {
  const reply = tab.slice(tab.indexOf('replyComposer={(m, close) => ('), tab.indexOf('footer={'))
  assert.match(reply, /<MessageComposer\s*\n\s*inline\s*\n\s*onClose=\{close\}/)
  assert.doesNotMatch(reply, /setAskSeed/)
  // To is whoever the email was with.
  assert.match(reply, /m\.direction === 'inbound' \? m\.senderId : \(m\.toIds \|\| \[\]\)\[0\]/)
  // A stable nonce, so a re-render does not reset what the rep is typing.
  assert.match(reply, /nonce: m\.id/)
  // The foot composer is for new messages only.
  const foot = tab.slice(tab.indexOf('footer={'), tab.indexOf('dealTargets={siblingDeals}'))
  assert.doesNotMatch(foot, /replyTarget/)
  // Timeline opens it in the card whose thread holds the email.
  assert.match(timeline, /onReplyEmail=\{replyComposer \? setReplyTo : onReplyEmail\}/)
  assert.match(timeline, /thread\.some\(\(t\) => t\.id === replyTo\.id\)/)
  const card = readFileSync(new URL('../EmailThreadCard.jsx', import.meta.url), 'utf8')
  assert.match(card, /\{inlineComposer && <div className="pp-thread-reply">\{inlineComposer\}<\/div>\}/)
  // Inline: Email only, closed by its X and after sending.
  assert.match(src, /const \[expanded, setExpanded\] = useState\(inline\)/)
  assert.match(src, /onClick=\{\(\) => \(onClose \? onClose\(\) : setExpanded\(false\)\)\}/)
  assert.match(src, /onSent\?\.\(mode\)\s*\n\s*\/\/[^\n]*\n\s*onClose\?\.\(\)/)
})

test('the composer sits inside the timeline card, after the empty state', () => {
  assert.match(timeline, /footer = null,/)
  const at = timeline.indexOf('{footer}')
  assert.ok(at > timeline.indexOf('rows.map((m, i) =>'), 'footer must follow the rows')
  assert.ok(at < timeline.indexOf('{viewing && ('), 'footer must sit inside the section')
})

test('channels wear GHL\'s icons and colours', () => {
  assert.match(src, /if \(channel === 'WhatsApp'\) return 'whatsapp'/)
  // iMessage is filed under SMS by GHL, so it is told apart by name.
  assert.match(src, /if \(\/imessage\/i\.test\(label\)\) return 'imessage'/)
  assert.match(src, /<svg className="pp-composer-ico pp-composer-ico-whatsapp"/)
  const css = readFileSync(new URL('../composer.css', import.meta.url), 'utf8')
  assert.match(css, /\.pp-composer-ico-whatsapp \{ color: #25d366; \}/)
  assert.match(css, /\.pp-composer-ico-sms \{ color: #e8a317; \}/)
})

test('attachments upload on pick and go out as urls', () => {
  assert.match(api, /uploadMessageAttachments: \(id, contactId, files\) =>/)
  // apiClient defaults to JSON, which makes axios stringify the FormData and
  // drop the files — the upload must name multipart.
  const upload = api.slice(api.indexOf('uploadMessageAttachments:'))
  assert.match(upload.slice(0, upload.indexOf('},')), /headers: \{ 'Content-Type': 'multipart\/form-data' \}/)
  assert.match(src, /dealsAPI\.uploadMessageAttachments\(dealId, person\.id, list\)/)
  assert.match(src, /attachments: ready\.map\(\(f\) => f\.url\)/)
  // Send waits for an upload in flight; a photo alone is a valid SMS.
  assert.match(src, /const canSend = !sending && !uploading/)
  assert.match(src, /: !text\.trim\(\) && ready\.length === 0/)
  // GHL's accepted types, and none on an internal comment.
  assert.match(src, /const ATTACH_ACCEPT = '\.jpg,\.jpeg,\.png,\.mp4,\.mpeg,\.zip,\.rar,\.pdf,\.doc,\.docx,\.txt,\.mp3,\.wav'/)
  assert.match(src, /const attachable = mode === 'message'/)
})

test("an email's paperclip is on the formatting row; SMS keeps it in the foot", () => {
  assert.match(src, /toolbarExtra=\{\s*\n\s*<button type="button" className="pp-tb-btn" title="Attach files"/)
  assert.match(src, /\{attachable && !isEmail && \(\s*\n\s*<button type="button" className="pp-composer-icon" title="Attach files"/)
  // An email's Discard and Send share that row; its foot only shows a status.
  assert.match(src, /toolbarEnd=\{<><span className="pp-tb-sep" \/>\{actions\}<\/>\}/)
  assert.match(src, /\{\(!emailRow \|\| status\) && \(/)
  assert.match(src, /\{!emailRow && actions\}/)
  // The shared editor only grows a slot; nothing renders without it.
  const editor = readFileSync(new URL('../../shared/RichEditor.jsx', import.meta.url), 'utf8')
  assert.match(editor, /toolbarExtra = null/)
  assert.match(editor, /\{extra && \(/)
})

test('its styles are its own file — no shared rule changes', () => {
  assert.match(src, /import '\.\/composer\.css'/)
  const css = readFileSync(new URL('../composer.css', import.meta.url), 'utf8')
  for (const sel of css.match(/^\[data-dealhub\][^{]+/gm)) {
    assert.match(sel, /\.pp-composer/, `selector outside the composer: ${sel.trim()}`)
  }
})

test('focus shows once, on the card border — gold for a comment', () => {
  assert.match(src, /className="pp-composer-textarea pp-focus-inherit"/)
  assert.doesNotMatch(src, /className="pp-composer-input"/)
  const css = readFileSync(new URL('../composer.css', import.meta.url), 'utf8')
  assert.match(css, /\.pp-composer \.pp-editor-content:focus-visible \{ box-shadow: none; \}/)
  assert.match(css, /\.pp-composer-comment:focus-within \{ border-color: var\(--accent-gold-text\); \}/)
})

test('Reply scrolls the whole box into view once it has settled', () => {
  // The box grows after mount (the editor, then the From row when the sender
  // catalogue loads), so a scroll on the next frame stopped short.
  assert.match(src, /editor\?\.focus\(\{ preventScroll: true \}\)/)
  assert.match(src, /new ResizeObserver\(\(\) => \{ window\.clearTimeout\(quiet\); quiet = window\.setTimeout\(reveal, 150\) \}\)/)
  assert.match(src, /cap = window\.setTimeout\(reveal, 1500\)/)
  // Smooth, then an instant 'nearest' as the guarantee.
  assert.match(src, /scrollIntoView\(\{ behavior: 'smooth', block: 'nearest' \}\)/)
  assert.match(src, /scrollIntoView\(\{ behavior: 'auto', block: 'nearest' \}\), 700\)/)
})

test('an internal comment is drawn as a conversation row, not a NOTE card', () => {
  // One constant decides both the title saved and the row recognised.
  assert.match(src, /export const COMMENT_TITLE = 'Internal comment'/)
  assert.match(timeline, /import \{ COMMENT_TITLE \} from '\.\/MessageComposer'/)
  // Either signal: the server's flag (it also clears the title) or the title.
  assert.match(timeline, /m\.isInternalComment === true \|\| String\(m\.title \|\| ''\)\.trim\(\) === COMMENT_TITLE/)
  // The note row draws it — one implementation, the team's: the message
  // rows' avatar with the eye badge, and the gold bubble.
  const row = timeline.slice(timeline.indexOf('function EntryRow'))
  assert.match(row, /const isComment = isInternalCommentRow\(m\)/)
  assert.match(row, /<SenderAvatar[\s\S]*?icon="visibility"/)
  assert.match(row, /background: 'var\(--tint-gold\)', border: '1px solid var\(--accent-gold\)'/)
  assert.doesNotMatch(timeline, /function CommentRow/)
  // It names its author: the composer passes the signed-in rep.
  assert.match(src, /userId: session\?\.user\?\.id \|\| undefined/)
  const notesApi = readFileSync(new URL('../../../api/notes.js', import.meta.url), 'utf8')
  assert.match(notesApi, /opportunityId, businessId, userId\s*\n?\s*\}\)/)
})

test('the timeline reads oldest-first and opens at the newest', () => {
  // Newest at the bottom, under which the composer sits — a conversation.
  assert.match(timeline, /return kept\.slice\(\)\.reverse\(\)\.sort\(\(a, b\) => t\(a\) - t\(b\)\)/)
  // A thread keeps its place by its NEWEST email, so a reply moves it down.
  assert.match(timeline, /arr\.reduce\(\(a, b\) => \(new Date\(b\.ts\) > new Date\(a\.ts\) \? b : a\)\)/)
  // Opens pinned to the bottom, and stops following once the rep scrolls up.
  assert.match(timeline, /if \(el\) el\.scrollTop = el\.scrollHeight/)
  assert.match(timeline, /atBottom\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < 80/)
  // Threads are still built from the server's newest-first list — the
  // thread card expects its mails newest-first.
  assert.match(timeline, /const threads = useMemo\(\(\) => buildThreads\(messages\), \[messages\]\)/)
})

test('the timeline loads older pages as the rep scrolls up', () => {
  const api = readFileSync(new URL('../../../api/deals.js', import.meta.url), 'utf8')
  assert.match(api, /timeline: \(id, params\) =>/)
  // The Deal Hub asks for the newest page first, then older ones by cursor.
  assert.match(tab, /dealsAPI\.timeline\(dealId, \{ limit: TIMELINE_PAGE \}\)/)
  assert.match(tab, /dealsAPI\.timeline\(dealId, \{ limit: TIMELINE_PAGE, before: cur\.before \}\)/)
  assert.match(tab, /hasMore=\{olderState\.hasMore\}/)
  assert.match(tab, /onLoadMore=\{loadOlder\}/)
  // Select all covers the whole deal, not just the loaded pages.
  assert.match(tab, /const extra = timelineMore\.current\.hasMore \? await loadAllOlder\(\)/)
  // A sentinel at the oldest end, watched inside the scroll box.
  assert.match(timeline, /<div ref=\{sentinelRef\} aria-hidden="true" style=\{\{ height: 1 \}\} \/>/)
  assert.match(timeline, /\{ root, rootMargin: '300px 0px 0px 0px' \}/)
  // The view holds still when older rows land above.
  assert.match(timeline, /el\.scrollTop = anchor\.current\.top \+ \(el\.scrollHeight - anchor\.current\.height\)/)
})
