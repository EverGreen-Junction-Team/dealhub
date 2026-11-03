import React, { useEffect, useMemo, useRef, useState } from 'react'
import { dealsAPI } from '../../api/deals'
import { providersAPI } from '../../api/providers'
import { controlAPI } from '../../api/control'
import { notesAPI } from '../../api/notes'
import { useAuth } from '../../context/AuthContext'
import RichEditor from '../shared/RichEditor'
import RecipientsField from '../../components/RecipientsField'
import UserMentions from './UserMentions'
import { findMentionQuery } from './SkillMentions'
import { mentionMarkup } from '../../utils/mentions.jsx'
import { isHtmlEmpty } from '../../utils/sanitiseHtml'
import './composer.css'

// The timeline composer — GHL's Conversations composer, docked under the deal's
// timeline, so a rep can answer the customer without leaving the deal.
//
//   collapsed   [✉ ⌄]  Type a message…                           [ ➤ ]
//
//   expanded    [✉ Email ⌄] | [👁 Internal Comment]               –  ⤢
//               From  [sender ⌄]
//               To    [contact ⌄]                             CC  BCC
//               Subject: …
//               body …
//               error / status                          [Discard] [Send]
//
// SENDS DIRECTLY. Unlike a Co-Pilot draft there is no propose/confirm step:
// the rep wrote it, so pressing Send is the confirmation. The server checks
// the recipient is on this deal and not on DND before anything goes out.
//
// THE CHANNEL LIST is GHL's: one entry per way a message can leave — Email,
// then every SMS/WhatsApp sender the location has (native, "WhatsApp QR",
// "SMS Android", "iMessage"). A custom provider is sent as its channel plus
// its provider id; the server turns that into GHL's type 'Custom'.
//
// INTERNAL COMMENT. GHL has no API for creating its internal comments, so a
// comment here is saved as a note on the contact, linked to this deal and
// titled "Internal comment" — visible to the team in GHL's Notes and in this
// timeline, never sent to the customer.

// Also how the timeline recognises a comment among notes (Timeline's
// CommentRow) — one constant, so the two cannot drift.
export const COMMENT_TITLE = 'Internal comment'

const DND_KEY = { Email: 'email', SMS: 'sms', WhatsApp: 'whatsapp' }

// Which icon a channel entry wears — GHL's: a blue envelope for Email, the
// green WhatsApp mark for WhatsApp and "WhatsApp QR", a blue bubble for
// iMessage, an amber SMS bubble for SMS and "SMS Android". By provider NAME
// for iMessage, because GHL files it under the SMS channel.
export function iconKind(channel, label = '') {
  if (channel === 'Email') return 'email'
  if (channel === 'WhatsApp') return 'whatsapp'
  if (/imessage/i.test(label)) return 'imessage'
  return 'sms'
}

const WHATSAPP_PATH = 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z'

function ChannelIcon({ kind, size = 18 }) {
  if (kind === 'whatsapp') {
    return (
      <svg className="pp-composer-ico pp-composer-ico-whatsapp" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d={WHATSAPP_PATH} />
      </svg>
    )
  }
  const glyph = { email: 'mail', imessage: 'chat_bubble', sms: 'sms', comment: 'visibility' }[kind] || 'mail'
  return <span className={`ms pp-composer-ico pp-composer-ico-${kind}`} style={{ fontSize: size }} aria-hidden="true">{glyph}</span>
}

// GHL's accepted attachment types (POST /conversations/messages/upload).
const ATTACH_ACCEPT = '.jpg,.jpeg,.png,.mp4,.mpeg,.zip,.rar,.pdf,.doc,.docx,.txt,.mp3,.wav'
const fmtSize = (n) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

// Every way a message can leave, flattened the way GHL's dropdown lists them.
//
// Email is ONE entry — its senders (the location's email, a rep's Gmail) are a
// From choice, not separate channels. SMS and WhatsApp list each sender as its
// own entry, because to a rep "WhatsApp QR" and "SMS Android" ARE channels.
//
// The native option is only listed when GHL shows a native sender for it, or
// when it is the channel's only option: a location running only "SMS Android"
// has no native SMS, and offering it would send into a channel that is not
// connected.
export function channelOptions(channels = []) {
  const out = []
  const byName = Object.fromEntries((channels || []).map((c) => [c.channel, c]))
  if (byName.Email) {
    out.push({ key: 'Email', channel: 'Email', providerId: null, label: 'Email', kind: 'email' })
  }
  for (const channel of ['WhatsApp', 'SMS']) {
    const live = (byName[channel]?.providers || []).filter((p) => !p.isDeleted)
    const custom = live.filter((p) => p.id !== null && !p.isNative)
    const nativeRow = live.some((p) => p.id !== null && p.isNative)
    if (nativeRow || custom.length === 0) {
      if (live.length) {
        out.push({ key: `${channel}:native`, channel, providerId: null, label: channel, kind: iconKind(channel, channel) })
      }
    }
    for (const p of custom) {
      out.push({ key: `${channel}:${p.id}`, channel, providerId: p.id, label: p.name, kind: iconKind(channel, p.name) })
    }
  }
  return out
}

// Why this person cannot be sent to on this channel, or null when they can.
export function blockedReason(person, channel) {
  if (!person) return 'Pick who to send this to'
  if (channel === 'Email' && !person.email) return 'This contact has no email address'
  if (channel !== 'Email' && !person.phone) return 'This contact has no phone number'
  if (person.dnd?.all || person.dnd?.channels?.[DND_KEY[channel]]) {
    return `This contact has do-not-disturb on for ${channel}`
  }
  return null
}

const nameOf = (p) => [p?.firstName, p?.lastName].filter(Boolean).join(' ') || p?.email || p?.phone || 'Contact'
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const textToHtml = (s) => String(s || '').split(/\n/).map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join('')
// A deal person as an email recipient chip, in RecipientsField's shape.
const asRecipient = (p) => ({ contactId: p.id, name: nameOf(p), email: String(p.email || '').toLowerCase() })

// `inline` + `onClose`: the reply box a thread card opens under its emails —
// open from the start, Email only, closed (not minimised) by its X and once
// the reply has gone.
export default function MessageComposer({
  dealId, people = [], primaryContactId = null, replyTarget = null, onSent,
  inline = false, onClose = null,
  // The channel the conversation last ran on — { channel, providerId } from
  // the newest message in the timeline. Preselected, never forced: the rep
  // can still pick anything from the dropdown, but a thread on WhatsApp QR
  // should not open a composer pointed at Email by default.
  lastChannel = null
}) {
  const { session } = useAuth()
  const rootRef = useRef(null)
  const [expanded, setExpanded] = useState(inline)
  const [large, setLarge] = useState(false)
  const [mode, setMode] = useState('message')          // 'message' | 'comment'
  const [channels, setChannels] = useState(null)
  const [channelKey, setChannelKey] = useState(null)
  const [menu, setMenu] = useState(null)               // 'channel' | 'to' | 'from' | null
  // KEEP THE WHOLE BOX ON SCREEN AS IT GROWS. It sits at the foot of the
  // timeline card, so every way it gets taller — opening from the
  // minimised bar, switching to the email editor, the enlarge button, the
  // recipient rows appearing — pushed its bottom edge below the fold and a
  // rep typed into a box they could only half see. Watching its height is
  // the one mechanism that covers all of those, including the editor that
  // mounts a beat after the state change. Only once the rep has engaged
  // with it: a composer must not drag the page around on first render.
  const [engaged, setEngaged] = useState(false)
  // Re-attached whenever `expanded` flips: the collapsed bar and the open
  // composer are DIFFERENT root elements, so an observer bound to the bar
  // would be watching a node that is no longer on the page.
  useEffect(() => {
    const el = rootRef.current
    if (!el || !engaged || typeof ResizeObserver === 'undefined') return undefined
    let last = el.offsetHeight
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight
      if (h > last) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      last = h
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [engaged, expanded])
  // Opening from the bar: bring the freshly mounted composer into view at
  // once, and again shortly after for the lazily loaded email editor, which
  // adds its height a moment later.
  useEffect(() => {
    if (!expanded || !engaged) return undefined
    const into = () => rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const a = requestAnimationFrame(into)
    const b = window.setTimeout(into, 350)
    return () => { cancelAnimationFrame(a); window.clearTimeout(b) }
  }, [expanded, engaged])
  const [contactId, setContactId] = useState(primaryContactId)
  const [fromId, setFromId] = useState(null)
  // Email addresses, as GHL's composer has them: To, CC and BCC are chip
  // lists with a contact dropdown. GHL's send takes ONE To — the first, which
  // must be someone on this deal; any further To goes out as CC, the same
  // rule the Co-Pilot send applies (server actionExecutor).
  const [rcpt, setRcpt] = useState({ to: [], cc: [], bcc: [] })
  const [subject, setSubject] = useState('')
  const [html, setHtml] = useState('')
  const [text, setText] = useState('')
  const [reply, setReply] = useState(null)             // { messageId, subject }
  const [signature, setSignature] = useState(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [sent, setSent] = useState(null)
  // Files on this message: { key, name, size, url?, uploading, error? }.
  // Uploaded the moment they are picked — GHL wants the file before the send
  // and takes its URL on the message — so Send waits only for the text.
  const [files, setFiles] = useState([])
  const fileInputRef = useRef(null)

  // ── @-mentions in a comment ───────────────────────────────────────────
  // The textarea shows "@J srini" as the rep typed it; the GHL markup
  // (@J srini<userId>…</userId>) is written only on save, from this map of
  // the names that were picked from the menu — a name typed by hand with
  // no pick is just text. Users are fetched on the first @, not on mount.
  const taRef = useRef(null)
  const [mention, setMention] = useState(null)        // { start, query } | null
  const [users, setUsers] = useState(null)
  const [usersLoading, setUsersLoading] = useState(false)
  const [picked, setPicked] = useState({})            // name -> userId
  useEffect(() => {
    if (!mention || users !== null || usersLoading) return
    setUsersLoading(true)
    dealsAPI.users()
      .then((r) => setUsers(r?.users || []))
      .catch(() => setUsers([]))
      .finally(() => setUsersLoading(false))
  }, [mention, users, usersLoading])
  const syncMention = (value, caret) => setMention(findMentionQuery(value, caret))
  const pickUser = (u) => {
    if (!mention) return
    const ta = taRef.current
    const caret = ta ? ta.selectionStart : text.length
    const next = `${text.slice(0, mention.start)}@${u.name} ${text.slice(caret)}`
    setText(next)
    setPicked((m) => ({ ...m, [u.name]: u.id }))
    setMention(null)
    const pos = mention.start + u.name.length + 2
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(pos, pos) })
  }
  // "@Name" → GHL's mention markup, for every name picked from the menu.
  const withMentionMarkup = (value) => Object.entries(picked).reduce(
    (acc, [name, id]) => acc.split(`@${name}`).join(mentionMarkup(name, id)),
    value
  )

  useEffect(() => {
    let alive = true
    providersAPI.list({ scope: 'composable' })
      .then((r) => { if (alive) setChannels(r?.channels || []) })
      // No catalogue: Email alone still works through GHL's default sender.
      .catch(() => { if (alive) setChannels([{ channel: 'Email', providers: [] }]) })
    // The rep's saved signature, appended to emails the way Co-Pilot drafts
    // already carry it. Missing is normal — most reps have none.
    controlAPI.getSignature()
      .then((r) => { if (alive) setSignature(r?.signature?.html || null) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const options = useMemo(() => channelOptions(channels || []), [channels])
  // Default = the thread's last channel, matched by sender when it was a
  // custom one (WhatsApp QR, SMS Android) and by channel otherwise. Only
  // while the rep has not chosen; a chosen key always wins. First option
  // as the last resort, as before.
  const defaultKey = useMemo(() => {
    if (!lastChannel || !options.length) return null
    const ch = String(lastChannel.channel || '').toUpperCase()
    const name = ch === 'EMAIL' ? 'Email' : ch === 'WHATSAPP' ? 'WhatsApp' : ch === 'SMS' || ch === 'CUSTOM' ? 'SMS' : null
    if (lastChannel.providerId) {
      const byProvider = options.find((o) => o.providerId === lastChannel.providerId)
      if (byProvider) return byProvider.key
    }
    if (!name) return null
    if (name === 'Email') return options.some((o) => o.key === 'Email') ? 'Email' : null
    const native = options.find((o) => o.channel === name && o.providerId === null)
    if (native) return native.key
    const any = options.find((o) => o.channel === name)
    return any ? any.key : null
  }, [lastChannel, options])
  const option = options.find((o) => o.key === (channelKey || defaultKey)) || options[0] || null
  const channel = option?.channel || 'Email'
  const isEmail = channel === 'Email'

  const emailSenders = useMemo(() => {
    const g = (channels || []).find((c) => c.channel === 'Email')
    return (g?.providers || []).filter((p) => !p.isDeleted)
  }, [channels])
  const from = emailSenders.find((p) => (p.id ?? null) === (fromId ?? null)) || emailSenders[0] || null

  // The deal's primary is the default recipient, as it is in GHL; a new deal
  // (or a deal switch) resets to it.
  useEffect(() => {
    setContactId(primaryContactId)
    const primary = people.find((p) => p.id === primaryContactId) || people.find((p) => p.primary)
    setRcpt({ to: primary?.email ? [asRecipient(primary)] : [], cc: [], bcc: [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryContactId, dealId, people.length])
  const dealPerson = people.find((p) => p.id === contactId) || people.find((p) => p.primary) || people[0] || null
  // On an email the recipient is the FIRST To; elsewhere it is the To picker.
  const firstTo = rcpt.to[0] || null
  const emailing = mode === 'message' && isEmail
  const person = emailing
    ? (firstTo ? (people.find((p) => p.id === firstTo.contactId) || null) : null)
    : dealPerson
  const blocked = emailing
    ? (!firstTo ? 'Add who to send this to'
      : !person ? 'The first To must be someone on this deal — add other people after them'
        : blockedReason(person, channel))
    : mode === 'message' ? blockedReason(person, channel) : (person ? null : 'Pick who this is about')
  const dealOptions = useMemo(
    () => people.filter((p) => p.email).map((p) => ({ ...asRecipient(p), isPrimary: !!p.primary })),
    [people]
  )

  // Reply ↩ on a timeline email: open as an email to that sender, in that
  // thread. The nonce lets the same email be replied to twice.
  useEffect(() => {
    if (!replyTarget) return
    setMode('message')
    setChannelKey('Email')
    const who = people.find((p) => p.id === replyTarget.contactId)
    if (who) {
      setContactId(who.id)
      if (who.email) setRcpt({ to: [asRecipient(who)], cc: [], bcc: [] })
    }
    const base = String(replyTarget.subject || '').replace(/^\s*re:\s*/i, '')
    setSubject(base ? `Re: ${base}` : '')
    setReply({ messageId: replyTarget.messageId, subject: replyTarget.subject || '' })
    setExpanded(true)
    setError(null); setSent(null)
    // Bring the WHOLE box into view, Send included — and KEEP it there while
    // it settles. Scrolling once was too early: the editor mounts a beat
    // later, and the From row only appears when the sender catalogue loads,
    // so the box kept growing after the scroll and its bottom ended below the
    // timeline's fold. So: wait for the editor, focus it WITHOUT the
    // browser's own instant jump, then scroll ONCE when the box has stopped
    // changing size (150ms quiet, 1.5s at most). One smooth scroll to the
    // final size — re-scrolling on every change restarted the animation and
    // it never arrived. scrollIntoView moves the timeline's scroll box and
    // the page as needed.
    //
    // Then, 700ms on, an INSTANT 'nearest' as a guarantee: a no-op if the
    // smooth scroll arrived, and the fix if anything cut it short.
    let tries = 0
    let observer = null
    let quiet = null
    let cap = null
    let ensure = null
    const reveal = () => {
      observer?.disconnect(); window.clearTimeout(quiet); window.clearTimeout(cap)
      rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      ensure = window.setTimeout(() => rootRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' }), 700)
    }
    const settle = () => {
      const root = rootRef.current
      const editor = root?.querySelector('.ProseMirror')
      if (!root) return
      if (!editor && tries++ < 30) { window.requestAnimationFrame(settle); return }
      editor?.focus({ preventScroll: true })
      if (typeof ResizeObserver === 'undefined') { reveal(); return }
      observer = new ResizeObserver(() => { window.clearTimeout(quiet); quiet = window.setTimeout(reveal, 150) })
      observer.observe(root)
      cap = window.setTimeout(reveal, 1500)
    }
    window.requestAnimationFrame(settle)
    return () => {
      observer?.disconnect()
      window.clearTimeout(quiet); window.clearTimeout(cap); window.clearTimeout(ensure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTarget?.nonce])

  // Close an open menu on an outside click.
  useEffect(() => {
    if (!menu) return
    const onDown = (e) => { if (!e.target.closest?.('.pp-composer-menuwrap')) setMenu(null) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menu])

  const ready = files.filter((f) => f.url)
  const uploading = files.some((f) => f.uploading)
  const attachable = mode === 'message'
  // A photo alone is a real SMS/WhatsApp message; an email still needs words.
  const bodyEmpty = mode === 'comment' ? !text.trim()
    : isEmail ? isHtmlEmpty(html)
      : !text.trim() && ready.length === 0
  const canSend = !sending && !uploading && !blocked && !bodyEmpty
    && (mode === 'comment' || !isEmail || subject.trim())

  const reset = () => {
    setHtml(''); setText(''); setPicked({}); setMention(null)
    // The To stays for a follow-up; CC and BCC were for that one email.
    setRcpt((r) => ({ to: r.to, cc: [], bcc: [] }))
    setReply(null); setSubject('')
    setFiles([])
    setError(null)
  }

  const attach = async (picked) => {
    const list = [...(picked || [])]
    if (!list.length || !person) return
    const added = list.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, size: f.size, uploading: true }))
    setFiles((cur) => [...cur, ...added])
    try {
      const r = await dealsAPI.uploadMessageAttachments(dealId, person.id, list)
      const back = r?.files || []
      setFiles((cur) => cur.map((f) => {
        const i = added.findIndex((a) => a.key === f.key)
        if (i < 0) return f
        const got = back.find((b) => b.name === f.name) || back[i]
        return got?.url ? { ...f, url: got.url, uploading: false } : { ...f, uploading: false, error: 'Did not upload' }
      }))
    } catch (e) {
      // The whole batch failed: say why on each chip, so the rep removes
      // them rather than sending without noticing.
      setFiles((cur) => cur.map((f) => (added.some((a) => a.key === f.key)
        ? { ...f, uploading: false, error: e?.message || 'Did not upload' } : f)))
    }
  }

  // PASTE AND DROP go through the same attach() as the paperclip, on every
  // message channel and never on a comment (a comment is text; the paste
  // falls through to the textarea). A pasted screenshot arrives from the
  // clipboard as "image.png" every time, and attach() matches the upload
  // response back to the chip by name — so clipboard files get a unique
  // name before they go, or two screenshots would both resolve to the
  // first one's URL.
  const clipboardFiles = (dt) => {
    const out = []
    for (const item of dt?.items || []) {
      if (item.kind === 'file') { const f = item.getAsFile(); if (f) out.push(f) }
    }
    if (!out.length) out.push(...(dt?.files || []))
    return out
  }
  const uniquelyNamed = (list) => list.map((f, i) => {
    const generic = !f.name || /^(image|pasted)\.(png|jpe?g|gif|webp)$/i.test(f.name)
    if (!generic) return f
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
    return new File([f], `pasted-${Date.now()}-${i + 1}.${ext}`, { type: f.type })
  })
  const onPasteCapture = (e) => {
    if (!attachable) return
    const list = clipboardFiles(e.clipboardData)
    if (!list.length) return
    e.preventDefault()
    attach(uniquelyNamed(list))
  }
  const onDragOver = (e) => {
    if (attachable && [...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault()
  }
  const onDrop = (e) => {
    if (!attachable) return
    const list = [...(e.dataTransfer?.files || [])]
    if (!list.length) return
    e.preventDefault()
    attach(uniquelyNamed(list))
  }

  const send = async () => {
    if (!canSend) return
    setSending(true); setError(null); setSent(null)
    try {
      if (mode === 'comment') {
        await notesAPI.create({
          contactId: person.id,
          title: COMMENT_TITLE,
          // Trimmed: a trailing newline became an empty <p><br></p>, and the
          // bubble drew a blank line under every one-line comment. Mentions
          // picked from the @ menu are written in GHL's markup.
          body: textToHtml(withMentionMarkup(text.trim())),
          opportunityId: dealId,
          // The author, so the timeline row names who wrote it.
          userId: session?.user?.id || undefined
        })
        setSent('Comment saved — visible only to your team')
      } else {
        let bodyHtml = html
        if (isEmail && signature && !bodyHtml.includes(signature)) bodyHtml = `${bodyHtml}<br>${signature}`
        await dealsAPI.sendMessage(dealId, {
          type: channel,
          contactId: person.id,
          conversationProviderId: isEmail ? (from?.id ?? null) : option.providerId,
          attachments: ready.map((f) => f.url),
          ...(isEmail
            ? {
                subject: subject.trim(),
                html: bodyHtml,
                emailTo: firstTo.email,
                emailCc: [...rcpt.to.slice(1), ...rcpt.cc].map((r) => r.email),
                emailBcc: rcpt.bcc.map((r) => r.email),
                replyToMessageId: reply?.messageId || undefined
              }
            : { message: text.trim() })
        })
        setSent(`Sent to ${nameOf(person)}`)
      }
      reset()
      onSent?.(mode)
      // An inline reply has done its job once it is sent.
      onClose?.()
    } catch (e) {
      setError(e?.message || 'Could not send — nothing was sent. Try again.')
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
  }

  const pickChannel = (o) => {
    setMenu(null)
    if (o === 'comment') { setMode('comment'); return }
    setMode('message')
    // Plain text carries across channels so a switch does not lose typing.
    if (o.channel !== 'Email' && isEmail && !text && !isHtmlEmpty(html)) {
      const d = document.createElement('div'); d.innerHTML = html; setText(d.innerText.trim())
    }
    setChannelKey(o.key)
  }

  // ── Collapsed: one line, as under GHL's thread ─────────────────────────
  if (!expanded) {
    return (
      <div ref={rootRef} className="pp-composer pp-composer-collapsed">
        <button type="button" className="pp-composer-chan" title={`Send by ${option?.label || 'Email'}`}
          onClick={() => { setEngaged(true); setExpanded(true) }}>
          <ChannelIcon kind={option?.kind || 'email'} />
          <span className="ms pp-composer-caret">expand_more</span>
        </button>
        <button type="button" className="pp-composer-placeholder" onClick={() => { setEngaged(true); setExpanded(true) }}>
          Type a message
        </button>
        <button type="button" className="pp-composer-send" disabled title="Write a message first">
          <span className="ms">send</span>
        </button>
        {sent && <span className="pp-composer-sent">{sent}</span>}
      </div>
    )
  }

  const comment = mode === 'comment'
  // An email's formatting row also carries Discard and Send.
  const emailRow = !comment && isEmail
  const status = error || blocked || sent || ''
  const actions = (
    <>
      <button type="button" className="pp-composer-icon" title="Discard" disabled={sending}
        onClick={() => { reset(); setSent(null) }}>
        <span className="ms">delete</span>
      </button>
      <button type="button" className="pp-composer-send" disabled={!canSend} onClick={send}
        title={blocked || (comment ? 'Save comment (Ctrl+Enter)'
          : `Send (Ctrl+Enter)${isEmail && signature ? ' — your signature is added' : ''}`)}>
        {sending ? <span className="pp-composer-sending">…</span> : <span className="ms">send</span>}
      </button>
    </>
  )
  return (
    <div ref={rootRef} className={`pp-composer${comment ? ' pp-composer-comment' : ''}${large ? ' pp-composer-large' : ''}`}
      onKeyDown={onKeyDown}
      // Clicking into the composer brings the WHOLE of it on screen. It sits
      // at the foot of the timeline card, so the bottom edge — the send
      // button and the attachment row — was often just below the fold, and
      // a rep typed into a box they could only half see. `nearest` scrolls
      // the least distance that makes it fully visible, and nothing at all
      // when it already is.
      onFocusCapture={() => {
        setEngaged(true)
        requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
      }}
      onMouseDownCapture={() => setEngaged(true)}
      // Capture phase, so a pasted image is taken as an attachment before the
      // rich editor sees the paste and discards it (it refuses base64 images).
      onPasteCapture={onPasteCapture}
      onDragOver={onDragOver}
      onDrop={onDrop}>
      {/* Header: channel | Internal Comment, then minimise / enlarge.
          INLINE (a reply inside a thread card) there is nothing to switch:
          it is an email in that thread, so the header just says so and the
          minimise becomes a close, as GHL's inline reply box has it. */}
      <div className="pp-composer-head">
        {inline ? (
          <span className="pp-composer-tab pp-composer-tab-on">
            <ChannelIcon kind="email" />
            Reply
          </span>
        ) : (<>
        <span className="pp-composer-menuwrap">
          <button type="button" className={`pp-composer-tab${!comment ? ' pp-composer-tab-on' : ''}`}
            onClick={() => (comment ? setMode('message') : setMenu(menu === 'channel' ? null : 'channel'))}>
            <ChannelIcon kind={option?.kind || 'email'} />
            {option?.label || 'Email'}
            <span className="ms pp-composer-caret">expand_more</span>
          </button>
          {menu === 'channel' && (
            <div className="pp-composer-menu" role="menu">
              {options.map((o) => (
                <button key={o.key} type="button" role="menuitem" className="pp-composer-menuitem"
                  onClick={() => pickChannel(o)}>
                  <ChannelIcon kind={o.kind} />
                  <span className="pp-composer-menulabel">{o.label}</span>
                  {!comment && o.key === option?.key && <span className="ms pp-composer-check">check</span>}
                </button>
              ))}
              <button type="button" role="menuitem" className="pp-composer-menuitem" onClick={() => pickChannel('comment')}>
                <ChannelIcon kind="comment" size={16} />
                <span className="pp-composer-menulabel">{COMMENT_TITLE}</span>
              </button>
            </div>
          )}
        </span>
        <span className="pp-composer-divider" />
        <button type="button" className={`pp-composer-tab${comment ? ' pp-composer-tab-on' : ''}`}
          onClick={() => setMode('comment')}>
          <ChannelIcon kind="comment" size={16} />
          {COMMENT_TITLE}
        </button>
        </>)}
        <span style={{ flex: 1 }} />
        <button type="button" className="pp-composer-icon" title={onClose ? 'Close' : 'Minimise'}
          onClick={() => (onClose ? onClose() : setExpanded(false))}>
          <span className="ms">{onClose ? 'close' : 'remove'}</span>
        </button>
        <button type="button" className="pp-composer-icon" title={large ? 'Smaller' : 'Larger'} onClick={() => setLarge((v) => !v)}>
          <span className="ms">{large ? 'close_fullscreen' : 'open_in_full'}</span>
        </button>
      </div>

      {/* Addressing — not for an internal comment, which goes nowhere. */}
      {!comment && (
        <div className="pp-composer-fields">
          {isEmail && emailSenders.length > 0 && (
            <div className="pp-composer-row">
              <span className="pp-composer-k">From</span>
              <span className="pp-composer-menuwrap">
                <button type="button" className="pp-composer-chip"
                  disabled={emailSenders.length < 2}
                  onClick={() => setMenu(menu === 'from' ? null : 'from')}>
                  {from?.emailFrom || (from?.id == null ? 'Location email (default)' : from?.name)}
                  {emailSenders.length > 1 && <span className="ms pp-composer-caret">expand_more</span>}
                </button>
                {menu === 'from' && (
                  <div className="pp-composer-menu" role="menu">
                    {emailSenders.map((p) => (
                      <button key={p.id ?? 'native'} type="button" className="pp-composer-menuitem"
                        onClick={() => { setFromId(p.id ?? null); setMenu(null) }}>
                        <span className="pp-composer-menulabel">
                          {p.emailFrom || (p.id == null ? 'Location email (default)' : p.name)}
                        </span>
                        {(p.id ?? null) === (from?.id ?? null) && <span className="ms pp-composer-check">check</span>}
                      </button>
                    ))}
                  </div>
                )}
              </span>
            </div>
          )}
          {isEmail ? (
            <div className="pp-composer-recipients">
              <RecipientsField value={rcpt} onChange={setRcpt} options={dealOptions} scope="all" collapsibleCc />
            </div>
          ) : (
            <div className="pp-composer-row">
              <span className="pp-composer-k">To</span>
              <span className="pp-composer-menuwrap">
                <button type="button" className="pp-composer-chip" disabled={people.length < 2}
                  onClick={() => setMenu(menu === 'to' ? null : 'to')}>
                  <span className="pp-composer-avatar">{nameOf(person).slice(0, 2).toUpperCase()}</span>
                  {isEmail ? (person?.email || nameOf(person)) : (person?.phone || nameOf(person))}
                  {people.length > 1 && <span className="ms pp-composer-caret">expand_more</span>}
                </button>
                {menu === 'to' && (
                  <div className="pp-composer-menu" role="menu">
                    {people.map((p) => {
                      const why = blockedReason(p, channel)
                      return (
                        <button key={p.id} type="button" className="pp-composer-menuitem" title={why || undefined}
                          onClick={() => { setContactId(p.id); setMenu(null) }}>
                          <span className="pp-composer-menulabel">
                            {nameOf(p)}
                            <span className="pp-composer-sub">{why || (isEmail ? p.email : p.phone)}</span>
                          </span>
                          {p.id === person?.id && <span className="ms pp-composer-check">check</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
              </span>
            </div>
          )}
          {isEmail && (
            <div className="pp-composer-row">
              <span className="pp-composer-k">Subject:</span>
              <input className="pp-composer-input pp-focus-inherit" value={subject} onChange={(e) => setSubject(e.target.value)}
                placeholder="Enter subject" aria-label="Subject" />
            </div>
          )}
          {/* Inline, the thread card above already says which thread. */}
          {isEmail && reply && !inline && (
            <div className="pp-composer-reply">
              <span className="ms">reply</span>
              Replying in the thread “{reply.subject || '(no subject)'}”
              <button type="button" className="pp-composer-link" title="Send as a new email instead"
                onClick={() => setReply(null)}>
                New email instead
              </button>
            </div>
          )}
        </div>
      )}

      <div className="pp-composer-body">
        {!comment && isEmail ? (
          <RichEditor value={html} onChange={setHtml} placeholder="Type a message" minHeight={large ? 320 : 120}
            // On the formatting row with Bold and Link, as GHL has it.
            toolbarExtra={
              <button type="button" className="pp-tb-btn" title="Attach files" aria-label="Attach files"
                disabled={sending || !person}
                onMouseDown={(e) => { e.preventDefault(); fileInputRef.current?.click() }}>
                <span className="ms" style={{ fontSize: 17 }}>attach_file</span>
              </button>
            }
            // Discard and Send on the same row, at the right — GHL's layout.
            toolbarEnd={<><span className="pp-tb-sep" />{actions}</>} />
        ) : (
          <div style={{ position: 'relative' }}>
            {comment && mention && (
              <UserMentions
                users={users || []}
                loading={usersLoading}
                query={mention.query}
                onPick={pickUser}
                onClose={() => setMention(null)}
                anchorRef={rootRef}
              />
            )}
            <textarea
              ref={taRef}
              className="pp-composer-textarea pp-focus-inherit"
              value={text}
              onChange={(e) => { setText(e.target.value); if (comment) syncMention(e.target.value, e.target.selectionStart) }}
              onClick={(e) => { if (comment) syncMention(e.target.value, e.target.selectionStart) }}
              onKeyUp={(e) => { if (comment && e.key.startsWith('Arrow') && !mention) syncMention(e.target.value, e.target.selectionStart) }}
              onKeyDown={(e) => {
                if (!comment || !mention) return
                // The menu owns arrows, Enter and Escape while open; the
                // caret stays in the textarea and the keys are relayed.
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  window.dispatchEvent(new CustomEvent('pp-mention-key', { detail: e.key === 'ArrowDown' ? 'down' : 'up' }))
                } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                  e.preventDefault()
                  window.dispatchEvent(new CustomEvent('pp-mention-key', { detail: 'pick' }))
                } else if (e.key === 'Escape') {
                  e.preventDefault(); setMention(null)
                }
              }}
              rows={large ? 12 : 3}
              placeholder={comment ? 'Internal comment - visible only to your team. Type @ to mention a colleague.' : 'Type a message'}
            />
          </div>
        )}
      </div>

      {/* The files on this message, under the body as GHL shows them. */}
      {attachable && files.length > 0 && (
        <div className="pp-composer-files">
          {files.map((f) => (
            <span key={f.key} className={`pp-composer-file${f.error ? ' pp-composer-file-err' : ''}`}
              title={f.error || f.name}>
              <span className="ms">{f.uploading ? 'progress_activity' : f.error ? 'error' : 'attach_file'}</span>
              <span className="pp-composer-filename">{f.name}</span>
              <span className="pp-composer-filesize">{f.uploading ? 'Uploading…' : f.error ? f.error : fmtSize(f.size)}</span>
              <button type="button" className="pp-composer-fileremove" title="Remove"
                onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))}>
                <span className="ms">close</span>
              </button>
            </span>
          ))}
        </div>
      )}

      {attachable && (
        <input ref={fileInputRef} type="file" multiple hidden accept={ATTACH_ACCEPT}
          onChange={(e) => { attach(e.target.files); e.target.value = '' }} />
      )}

      {/* The foot. An email's actions are on its formatting row, so for an
          email this only appears when there is something to say — an error,
          why it cannot send, or that it went. SMS, WhatsApp and comments have
          no formatting row, so their paperclip and actions live here. */}
      {(!emailRow || status) && (
        <div className="pp-composer-foot">
          {attachable && !isEmail && (
            <button type="button" className="pp-composer-icon" title="Attach files" disabled={sending || !person}
              onClick={() => fileInputRef.current?.click()}>
              <span className="ms">attach_file</span>
            </button>
          )}
          <span className={`pp-composer-status${error || blocked ? ' pp-composer-status-err' : ''}`}>
            {status || (comment ? `Saved as a note on ${nameOf(person)} for this deal` : '')}
          </span>
          {!emailRow && actions}
        </div>
      )}
    </div>
  )
}
