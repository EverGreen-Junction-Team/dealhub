import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { aiAPI } from '../../api/ai'
import { dealsAPI } from '../../api/deals'
import { useAuth } from '../../context/AuthContext'
import NoteEditor from '../shared/NoteEditor'
import TaskEditor from '../shared/TaskEditor'
import { useDictation } from '../shared/useDictation'
import { useAttachments, MAX_ATTACHMENTS, ALLOWED_IMAGE_TYPES } from '../shared/useAttachments'
import {
  RecordingBar, AttachmentThumbnails, ImagePreview, IconButton
} from '../shared/ComposerExtras'
import CopilotSidebar from '../shared/CopilotSidebar'
import UserTurn from '../shared/UserTurn'
import ReactionRow from '../shared/ReactionRow'
import ActionCard from '../shared/ActionCard'
import MarkdownAnswer from './MarkdownAnswer'

// GHL stores user names however they were typed — same reasoning as the
// Deal Hub's own titleCase (DealSection.jsx) and the portfolio Co-Pilot's
// own copy (CopilotTab.jsx): title-case for display only, never for matching.
function titleCase(v) {
  if (!v) return v
  return String(v).replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
}

// Deal Hub — Co-Pilot panel.
//
// Two-column composition:
//   Left  · chat history — past questions on this deal, server-backed
//   Right · Co-Pilot: starter chips, the transcript, and the composer
//
// The five starters are written for a sales manager reviewing the deal (next
// step, biggest risk, undelivered promises, missing qualification, and the
// questions to ask next). They were cards in the left rail; as chips in the
// Co-Pilot header they sit where the question actually gets asked.
//
// Backend wiring lands next — for now the ask box just captures locally and
// the prompt cards echo the pick into the ask box so the manager can edit
// before hitting Ask. `onAsk` is the single seam that will call the LLM
// endpoint once it exists; nothing else in this file cares which model
// answers.
//
// Every prompt has its own accent (pine / rose / clay / gold / plum). The
// accent is applied to the icon chip + a subtle left rule; the card body
// stays neutral so a row of five cards doesn't turn into a rainbow.

const PROMPTS = [
  // `label` is the full question — it's what lands in the composer when picked.
  // `chipLabel` is the two-or-three-word form the chip shows; the full question
  // and the hint are both in the chip's tooltip.
  {
    id: 'next-step',
    icon: 'arrow_forward',
    accent: 'pine',
    chipLabel: 'Next step',
    label: 'What should I do next?',
    hint: 'Fills the next step and drafts a message'
  },
  {
    id: 'risk',
    icon: 'warning',
    accent: 'rose',
    chipLabel: 'Biggest risk',
    label: 'What is the biggest risk here?',
    hint: "Reads this deal's messages"
  },
  {
    id: 'promises',
    icon: 'handshake',
    accent: 'clay',
    chipLabel: 'Undelivered promises',
    label: 'What have we promised and not delivered?',
    hint: 'Checks commitments against the timeline'
  },
  {
    id: 'qualification',
    icon: 'rule',
    accent: 'gold',
    chipLabel: 'Missing qualification',
    label: 'What qualification is still missing?',
    hint: 'Against the gate for this stage'
  },
  {
    id: 'coaching',
    icon: 'psychology',
    accent: 'plum',
    chipLabel: 'Questions I should ask',
    // Deliberately points at the QUALIFICATION HEADINGS — the location's own
    // opportunity fields, shown in Control panel → Qualification headings. The
    // old wording ("how should the rep handle the price objection") assumed a
    // price objection that most deals do not have, so on a thread with no
    // pricing in it the answer was always "there is no price objection here".
    label: 'What questions should the rep ask to progress the meddic questions',
    hint: 'Questions to fill the qualification headings'
  }
]

export default function AskDeal({
  dealId, onAsk, onJumpToMessage, beforeAsk, messages = [],
  // The deal's contacts. Notes and tasks are stored against a CONTACT, so
  // "Save as note" needs one — without any, those actions stay disabled.
  people = [],
  // { text, nonce } — text to drop into the composer, from a Reply button on
  // the timeline. The nonce makes the same text seed twice in a row.
  seedQuestion = null,
  // Called with the action type when a card is CONFIRMED — the owner uses it
  // to refresh the timeline once the webhook for a sent message has landed.
  onActionConfirmed = null
}) {
  const [q, setQ] = useState('')
  // The email a seeded question is replying to — sent with the ask, not
  // shown in the composer. Cleared when the question goes, so a later,
  // unrelated question does not carry it.
  const [replyTo, setReplyTo] = useState(null)
  useEffect(() => {
    if (!seedQuestion) return
    // A reply seed leaves the box EMPTY: the context sits in a row above it
    // (see the composer), and the rep types only what the reply should say.
    setQ(seedQuestion.text || '')
    setReplyTo(seedQuestion.replyTo || null)
    requestAnimationFrame(() => inputRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuestion?.nonce])
  // Transcript of this deal's Q&A. Client-held: it's scratch context for
  // follow-ups, and every question is already persisted server-side in
  // ai_runs for the audit trail.
  const [turns, setTurns] = useState([])
  // Record an action's outcome in the turn, so a card that has been confirmed
  // does not revert to a live Confirm button when this remounts. Mirrors
  // CopilotTab — see the comment on its ActionCard.
  // Writes the outcome into BOTH the live transcript and the Recents
  // history. Only `turns` was patched before, and Recents reopens a chat
  // from `history` — a snapshot taken when the answer arrived, before the
  // rep confirmed anything. Switch to another chat and back, and the card
  // was rebuilt from that snapshot: a sent message offered again with a live
  // Confirm button. The server row was 'confirmed' the whole time.
  const onActionResolved = useCallback((actionId, outcome) => {
    if (outcome === 'confirmed' && onActionConfirmed) {
      // The type lives on the turn, not the callback — look it up.
      const hit = turns.flatMap((t) => t.proposedActions || []).find((a) => a.actionId === actionId)
      if (hit) onActionConfirmed(hit.actionType)
    }
    const patch = (list) => (list || []).map((t) => (
      t.proposedActions?.some((a) => a.actionId === actionId)
        ? {
            ...t,
            proposedActions: t.proposedActions.map((a) => (
              a.actionId === actionId ? { ...a, status: outcome } : a
            ))
          }
        : t
    ))
    setTurns(patch)
    setHistory((cur) => (cur || []).map((c) => (
      c.turns?.length ? { ...c, turns: patch(c.turns) } : patch([c])[0]
    )))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, onActionConfirmed])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const [available, setAvailable] = useState(null)
  const scrollRef = useRef(null)
  // The in-flight request's abort handle — same stop/cancel control the
  // portfolio Co-Pilot tab has. There's no server-side cancellation (the
  // model call keeps running either way), this only stops the REP from
  // waiting on it.
  const abortRef = useRef(null)
  // Which ask is CURRENT. Bumped on every submit and on every switch of
  // conversation, so a response from an earlier ask can tell it is stale.
  //
  // `pending` and the transcript are panel state, not conversation state: a
  // rep who asked, switched chats and pressed New chat saw "Reading the
  // thread…" in the empty new chat, and the old answer would have landed in
  // it. Aborting on switch covers the common case; the token covers the race
  // where the response is already in flight past the abort.
  const askSeq = useRef(0)
  const abandonAsk = () => {
    abortRef.current?.abort()
    abortRef.current = null
    askSeq.current += 1
    setPending(false)
  }

  // Is the AI layer configured at all? Without this the panel would offer a
  // button that always 503s.
  useEffect(() => {
    let alive = true
    aiAPI.status()
      .then((r) => alive && setAvailable(!!r.available))
      .catch(() => alive && setAvailable(false))
    return () => { alive = false }
  }, [])

  // Past chats for this deal, from ai_runs. Loading these is what makes the
  // panel resumable across reloads.
  const [history, setHistory] = useState([])
  const [activeChatId, setActiveChatId] = useState(null)
  // The conversation the live transcript belongs to. null = the next question
  // starts a new one. Sent with every follow-up so the server keeps the turns
  // together instead of logging each question as its own thread.
  const [conversationId, setConversationId] = useState(null)
  const [toast, setToast] = useState(null)
  // Per-question channel scope. Transient: narrows this answer only.
  const [channels, setChannels] = useState([])
  // Which run's "messages considered" modal is open.
  const [inspectRunId, setInspectRunId] = useState(null)
  const [composerFocused, setComposerFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  // Sidebar chrome — same shell as the portfolio Co-Pilot tab (New chat,
  // Search, Recents, Account/Memory), shared via CopilotSidebar so a future
  // tweak to that UI only has to happen once. Its own state (menus, rename,
  // settings modal) lives inside CopilotSidebar; this only needs the
  // collapse toggle, since that's presentation this panel's layout cares
  // about.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Full-view — the same transcript/state, just rendered as a full-screen
  // overlay instead of the embedded 560px panel. A longer conversation on
  // one deal deserves the same room the portfolio Co-Pilot tab always has;
  // this is a portal, not a second component, so nothing about the live
  // question, history, or in-flight request resets when a rep toggles it.
  const [fullView, setFullView] = useState(false)

  // The rep's display name, for the sidebar's Account avatar initials — same
  // lookup the portfolio Co-Pilot tab uses. The session only carries the GHL
  // user id, so it's resolved against the location's users list once per
  // mount.
  const { session } = useAuth()
  const [fullName, setFullName] = useState(null)
  useEffect(() => {
    const userId = session?.user?.id
    if (!userId) return
    // /me, not /users: that list is the rep picker and excludes agency
    // staff, so an agency admin — who is often the one signed in — could
    // never be found in it, and the avatar fell back to an icon.
    dealsAPI.me()
      .then((r) => {
        if (r?.user?.name) setFullName(titleCase(r.user.name))
      })
      .catch(() => {})
  }, [session?.user?.id])

  // Attached images and voice dictation — shared with the portfolio-wide
  // Co-Pilot tab (CopilotTab.jsx) via src/pages/shared/useAttachments.js and
  // useDictation.js, so a fix to either only has to happen once.
  const {
    attachments, addFiles, removeAttachment, clear: clearAttachments,
    preview, setPreview, fileRef, onPaste
  } = useAttachments({ onError: setError })
  const dictation = useDictation({ q, setQ, onError: setError, inputRef })
  const {
    supported: speechSupported, listening, heard, elapsed,
    start: startDictation, finish: finishDictation, cancel: cancelDictation
  } = dictation

  // Per-channel counts of what the AI would read right now, derived from the
  // live timeline rows rather than fetched — the server count would lag a
  // channel toggle, and the stale number is precisely the one the rep is
  // reading while deciding what to ask.
  const scope = useMemo(() => {
    const byChannel = {}
    let readable = 0
    let untranscribedCalls = 0
    let notes = 0
    let total = 0
    let deselected = 0

    let tasks = 0

    for (const m of messages) {
      // Events (opp created, DND enabled, …) aren't evidence.
      if (m.event) continue
      // A DESELECTED item is not read, so it must not be counted — the row
      // says what the agent will read, and counting an excluded note here
      // overstated it.
      if (m.included === false) { deselected++; continue }
      total++
      if (!m.readable) { untranscribedCalls++; continue }
      // Notes and tasks are both citable evidence (rule 7, migration 057).
      // Tasks were skipped here from before they reached the model, so the
      // ASK ABOUT row had no Tasks chip and its count ignored them.
      if (m.kind === 'task') { tasks++; readable++; continue }
      if (m.channel === 'NOTE' || m.kind === 'note') { notes++; readable++; continue }
      const key = String(m.channel || '').toLowerCase()
      byChannel[key] = (byChannel[key] || 0) + 1
      readable++
    }

    const unreadReasons = []
    if (untranscribedCalls > 0) {
      unreadReasons.push(
        `${untranscribedCalls} call${untranscribedCalls === 1 ? '' : 's'} not transcribed`
      )
    }
    if (deselected > 0) {
      unreadReasons.push(`${deselected} deselected`)
    }

    return {
      readable,
      notes,
      tasks,
      byChannel,
      coverage: { messagesTotal: total, messagesRead: readable, unreadReasons }
    }
  }, [messages])

  const loadHistory = () => {
    if (!dealId) return Promise.resolve()
    return aiAPI.askHistory(dealId)
      .then((r) => setHistory(r.chats || []))
      .catch(() => {})
  }

  // Switching deals clears the live transcript — the thread it was grounded
  // in is gone — and pulls that deal's own history.
  useEffect(() => {
    abandonAsk()
    setTurns([])
    setError(null)
    setQ('')
    setActiveChatId(null)
    setConversationId(null)
    setHistory([])
    setChannels([])
    setInspectRunId(null)
    loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId])

  // Reopen a past chat into the live transcript. It becomes the conversation,
  // so a follow-up carries its context.
  const reopen = (chat) => {
    // An answer still arriving for the chat being left would otherwise land
    // in this one.
    abandonAsk()
    const turnsIn = chat.turns?.length ? chat.turns : [chat]
    setTurns(
      turnsIn.flatMap((t) => [
        { role: 'user', content: t.question },
        {
          role: 'assistant',
          answerText: t.answerText,
          citations: t.citations || [],
          confidence: t.confidence,
          answered: t.answered,
          coverage: t.coverage,
          cached: true,
          runId: t.id,
          readMessageIds: t.readMessageIds || [],
          // The writes this turn proposed, and what became of them.
          //
          // Dropped here before: reopen() builds the turn field by field, so
          // a key the server sends but this list omits is silently lost. A
          // confirmed task's card vanished on reload and the answer offered
          // "Create task" again, ready to make a duplicate — the server was
          // returning the actions correctly and they never reached the turn.
          proposedActions: t.proposedActions || []
        }
      ])
    )
    setActiveChatId(chat.conversationId || chat.id)
    // Continue THIS thread: the next question appends to it rather than
    // starting a third conversation beside it.
    setConversationId(chat.conversationId || null)
    setError(null)
    setToast(
      turnsIn.length > 1 ? `Chat reopened — ${turnsIn.length} turns` : 'Chat reopened'
    )
    window.setTimeout(() => setToast(null), 2200)

    // Focus the composer — reopening a chat is nearly always a prelude to
    // asking the next thing in it. Same behaviour as the portfolio tab's
    // Recents, and as New chat here.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // Start a fresh conversation. The transcript clears and the next question
  // opens a new thread — the rail keeps everything that came before.
  const newChat = () => {
    abandonAsk()
    setTurns([])
    setConversationId(null)
    setActiveChatId(null)
    setError(null)
    setQ('')

    // Focus the composer: a new chat exists to be typed into, and the click
    // landed on the sidebar button, so focus is sitting there rather than
    // where the rep now wants to type.
    //
    // Unconditional, unlike the focus restore after an answer. That one guards
    // on focus being idle because the rep may have deliberately clicked
    // something else while waiting. Here the click IS the intent to start
    // typing, so there is no competing intent to respect.
    //
    // rAF so it runs after the cleared, re-enabled textarea has rendered —
    // focusing a disabled element silently does nothing.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [turns, pending])

  const submit = async (override) => {
    const typed = String(override ?? q).trim()
    // With a reply row up, the question is assembled from it: the rep's words
    // are what the reply should say, the row says which email. Sent with the
    // hidden id too (replyTo), so the server threads it onto that email.
    const value = replyTo
      ? `Reply to the email "${replyTo.subject || '(no subject)'}"${typed ? `: ${typed}` : ''}`
      : typed
    if (!value || pending) return
    if (onAsk) onAsk(value)

    setQ('')
    // The auto-grow sets an inline height on the textarea; clearing the value
    // doesn't undo it, so without this the box stays as tall as the question
    // that was just sent.
    if (inputRef.current) inputRef.current.style.height = 'auto'
    // Capture the attachments for THIS question and clear the composer. Read
    // into a local first: setState is async, so referencing `attachments`
    // inside the request below would race with the clear.
    const sentImages = attachments
    clearAttachments()
    // The thumbnails are gone, so a preview of one has nothing behind it.
    setPreview(null)
    setError(null)
    setPending(true)
    // Show the question immediately; the answer lands under it.
    // sentImages carries previewUrl/name for the transcript's own thumbnail
    // — separate from the mediaType/data pair sent to the model below, which
    // is all Claude needs and all the request should carry.
    setTurns((t) => [...t, { role: 'user', content: value, images: sentImages }])

    // Flush any pending include/exclude ticks first. The server derives the
    // message set itself, so an unsaved checkbox would silently not apply to
    // this question.
    if (beforeAsk) {
      try { await beforeAsk() } catch (err) { /* the toggle rolls itself back */ }
    }

    // Send only prior *answered* turns as history, so a failed attempt
    // doesn't poison the follow-up context.
    const history = turns
      .filter((t) => t.role === 'user' || (t.role === 'assistant' && t.answerText))
      .map((t) => ({
        role: t.role,
        content: t.role === 'user' ? t.content : t.answerText
      }))

    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++askSeq.current

    try {
      const sentReplyTo = replyTo
      setReplyTo(null)
      const res = await aiAPI.ask(dealId, {
        question: value,
        replyTo: sentReplyTo,
        conversationId,
        history,
        channels: channels.length ? channels : null,
        images: sentImages.map(({ mediaType, data }) => ({ mediaType, data })),
        signal: controller.signal
      })
      // Stale: the rep moved to another chat while this was in flight. The
      // abort usually gets here first, but a response already past it must
      // not be appended to a conversation it was never asked in.
      if (seq !== askSeq.current) return
      setTurns((t) => [
        ...t,
        {
          role: 'assistant',
          answerText: res.answerText,
          citations: res.citations || [],
          confidence: res.confidence,
          answered: res.answered !== false,
          coverage: res.coverage,
          cached: res.cached,
          runId: res.runId,
          readMessageIds: res.readMessageIds || [],
          channelScope: res.channelScope || null,
          // A write the question also asked for, detected separately from
          // the citation-verified answer above — see server's
          // dealActionDetector.js. Nothing has happened to the CRM yet.
          proposedActions: res.proposedActions || []
        }
      ])
      // The server generates one when we send none — hold it so the NEXT
      // question continues this thread rather than opening another.
      if (res.conversationId) setConversationId(res.conversationId)
      // activeChatId is compared against history rows' `conversationId`
      // (see CopilotSidebar's active-row highlight) — res.runId would never
      // match, since history is keyed by conversation, not by run.
      setActiveChatId(res.conversationId || res.runId)
      // The answer is now a resumable chat — pull it into the list.
      loadHistory()
    } catch (err) {
      // A rep-initiated stop, not a failure — the question they abandoned
      // just quietly disappears rather than surfacing as an error banner.
      // The user turn stays in the transcript so it's clear what was asked.
      // Same handling as the portfolio Co-Pilot tab's own stop button.
      if (seq !== askSeq.current || err?.code === 'ERR_CANCELED') {
        // Stale or stopped — either way the rep has moved on, and a banner
        // in the chat they moved TO would describe a question asked
        // somewhere else.
      } else {
        // Named failure states, never a permanent spinner (spec §5).
        const code = err.code
        setError(
          code === 'AI_NOT_CONFIGURED'
            ? 'The AI layer is not configured on the server yet.'
            : code === 'NO_CREDIT'
            ? 'The AI account has run out of credit. Ask an admin to top it up in the Anthropic console — retrying will not help until then.'
            // ECONNABORTED is the BROWSER giving up (axios hit
            // ASK_TIMEOUT_MS), TIMEOUT is the SERVER saying the model did.
            // Different causes, same thing to tell a rep — and without this
            // first case a client-side abort fell through to apiClient's
            // generic copy, which blames the connection for a model that was
            // simply slow and sends the rep to check their wifi.
            : code === 'TIMEOUT' || code === 'ECONNABORTED'
            ? 'The model took too long. Try again — long threads can be slow.'
            : code === 'MALFORMED'
            ? 'The model returned something unreadable. Try rephrasing the question.'
            : code === 'RATE_LIMITED'
            ? 'Rate limited. Wait a moment and try again.'
            : err.message || 'Could not get an answer.'
        )
      }
    } finally {
      // Only the CURRENT ask settles the panel. A stale one — abandoned by
      // a chat switch — must not clear a spinner that now belongs to a
      // newer question, or steal focus from wherever the rep went.
      if (seq === askSeq.current) {
        abortRef.current = null
        setPending(false)
        // Focus back to the composer so a follow-up can be typed straight away
        // — the whole point of a conversation is the next question, and having
        // to click back into the box every turn is friction on every single one.
        //
        // Only when focus is still nowhere in particular. A rep who clicked a
        // citation, the reasoning panel or another field while waiting has
        // deliberately moved on, and yanking the caret back would interrupt
        // them mid-action. `body` (or null) is the browser's "nothing focused"
        // state, which is exactly where focus sits after the disabled textarea
        // lost it on submit.
        //
        // requestAnimationFrame so this runs after the answer has rendered and
        // the textarea is enabled again — focusing a disabled element silently
        // does nothing.
        requestAnimationFrame(() => {
          const el = inputRef.current
          const active = document.activeElement
          const focusIsIdle = !active || active === document.body
          if (el && focusIsIdle) el.focus()
        })
      }
    }
  }

  const stopAsking = () => {
    abortRef.current?.abort()
  }

  const body = (
    // Same shell as the portfolio Co-Pilot tab — sidebar (New chat, Search,
    // Recents, Account/Memory) beside the conversation — just scoped to
    // this one deal: `history` here is askHistory(dealId), never the whole
    // pipeline, so Recents/Search only ever show this deal's own chats.
    //
    // Embedded and full-view share this exact tree — only the OUTER
    // wrapper's own size/position differs (see the two return branches
    // below) — so toggling never resets the live transcript, in-flight
    // question, or which chat is open.
    <div
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: `${sidebarCollapsed ? 64 : 280}px minmax(0, 1fr)`,
        height: '100%',
        background: '#fff'
      }}
    >
      {preview && (
        <ImagePreview
          attachment={preview}
          onClose={() => setPreview(null)}
        />
      )}

      {inspectRunId && (
        <MessagesConsideredModal
          runId={inspectRunId}
          onClose={() => setInspectRunId(null)}
          onJumpToMessage={onJumpToMessage}
        />
      )}

      <CopilotSidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
        recentsCollapsed={false}
        onToggleRecentsCollapsed={() => {}}
        // No collapse here — the toggle above is a no-op, so the chevron
        // would be a control that does nothing. The design shows a plain
        // RECENTS label.
        recentsCollapsible={false}
        empty={turns.length === 0}
        onNewChat={newChat}
        history={history}
        conversationId={activeChatId}
        onReopen={reopen}
        fullName={fullName}
        onDeleted={(deletedId) => {
          if (deletedId === activeChatId) { setTurns([]); setActiveChatId(null); setConversationId(null) }
          loadHistory()
        }}
        onRenamed={() => loadHistory()}
        style={{ height: '100%' }}
      />

      {/* Co-Pilot — flat content column, no card frame of its own.
          minHeight: 0 is required here, not just further down: a CSS GRID
          ITEM (this section, a child of the outer `display: grid`) defaults
          to min-height: auto, which refuses to shrink below its content's
          natural height. Without it, the transcript below could grow the
          whole section past the panel's fixed 560px row instead of
          scrolling inside it — pushing the composer below the visible
          panel entirely, which is what "composer not visible, not sticky"
          was: the section had no cap, so the browser just kept extending it
          downward past the frame. */}
      <section
        style={{
          background: '#fff',
          display: 'flex', flexDirection: 'column',
          minWidth: 0, minHeight: 0, padding: '0 16px 16px'
        }}
      >
        {toast && (
          <div
            role="status"
            style={{
              position: 'absolute', right: 16, bottom: 8,
              zIndex: 5,
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '9px 14px',
              borderRadius: 'var(--radius-md)',
              background: '#fff',
              boxShadow: 'var(--shadow-overlay)',
              fontSize: 'var(--text-md)', color: 'var(--text-heading)'
            }}
          >
            <span className="ms" style={{ fontSize: 17, color: 'var(--status-done)' }}>
              check_circle
            </span>
            {toast}
          </div>
        )}

        {/* Starter chips — sit where the question actually gets asked. The
            expand toggle sits at the row's far end rather than floating
            absolutely, so it never overlaps a wrapped second row of chips. */}
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            // 14 above, not 11: the design floats the chips a clear step
            // below the band rather than tucking them against it.
            padding: '14px 0 12px'
          }}
        >
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flex: 1 }}>
            {PROMPTS.map((p) => (
              <PromptChip
                key={p.id}
                prompt={p}
                onPick={() => {
                  setQ(p.label)
                  // Land the cursor in the composer so the chip is a starting
                  // point you can edit, not a committed question.
                  inputRef.current?.focus()
                }}
              />
            ))}
          </div>

          <button
            onClick={() => setFullView((v) => !v)}
            title={fullView ? 'Exit full view' : 'Open in full view'}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32, flex: 'none',
              border: 'none', borderRadius: 'var(--radius-sm)',
              background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 19 }}>
              {fullView ? 'close_fullscreen' : 'open_in_full'}
            </span>
          </button>
        </div>

        <div
          style={{
            padding: '0 4px', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
            // Fill the panel: the transcript takes the slack (min-height 0 so
            // it can shrink and scroll), the composer is pinned below it.
            flex: 1, minHeight: 0
          }}
        >
          {/* Empty state — a bare centered heading, matching the portfolio
              Co-Pilot's own greeting and the real GHL reference exactly. No
              icon disc, no subtitle, no trust chips: those read as a
              marketing card next to Ask AI's plain "What's on your mind?". */}
          {turns.length === 0 && (
            <div
              style={{
                flex: 1, minHeight: 0,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center'
              }}
            >
              <p style={{
                margin: 0, textAlign: 'center',
                fontSize: 'var(--text-3xl)', fontWeight: 600,
                letterSpacing: '-0.02em', color: 'var(--text-heading)'
              }}>
                Ask anything about this deal
              </p>
            </div>
          )}

          {available === false && (
            <p
              style={{
                margin: 0, padding: '10px var(--space-3)',
                borderLeft: '3px solid var(--status-working)',
                background: 'var(--tint-gold)',
                fontSize: 'var(--text-base)', lineHeight: 1.5, color: 'var(--text-body)'
              }}
            >
              The AI layer is not configured on this server yet — set
              ANTHROPIC_API_KEY to enable it.
            </p>
          )}

          {(turns.length > 0 || pending) && (
            <div
              ref={scrollRef}
              style={{
                // A COLUMN, not a grid. As a grid, the implicit rows shared the
                // container's fixed height between them: every turn was squeezed
                // to a fraction of it and, because a card clips its own overflow,
                // each answer was cut off mid-sentence — and the container never
                // exceeded its height, so no scrollbar ever appeared. A flex
                // column lets each turn keep its natural height, which is what
                // makes the sum overflow and the scrollbar show up.
                display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
                // Takes whatever height is going and scrolls inside itself, so
                // a long conversation never pushes the composer off-panel.
                flex: 1, minHeight: 0, overflowY: 'auto'
              }}
              className="pp-transcript"
            >
              {turns.map((t, i) =>
                t.role === 'user' ? (
                  // Shared with the portfolio Co-Pilot tab — same bubble,
                  // same product, just scoped to one deal.
                  <UserTurn
                    key={i} text={t.content}
                    images={t.images} onViewImage={setPreview}
                  />
                ) : (
                  <Answer
                    key={i}
                    turn={t}
                    onJumpToMessage={onJumpToMessage}
                    onInspect={t.runId ? () => setInspectRunId(t.runId) : undefined}
                    people={people}
                    onActionResolved={onActionResolved}
                  />
                )
              )}
              {pending && <Thinking />}
            </div>
          )}

          {error && (
            <p
              style={{
                margin: 0, padding: '10px var(--space-3)',
                borderLeft: '3px solid var(--status-stuck)',
                background: 'var(--tint-rose)',
                fontSize: 'var(--text-base)', lineHeight: 1.5, color: 'var(--status-stuck)'
              }}
            >
              {error}
            </p>
          )}

          {/* Composer — pinned to the bottom of the panel. marginTop:auto does
              the pinning when the transcript is empty; once it has content the
              transcript's flex:1 has already claimed the space. */}
          <div
            style={{
              marginTop: 'auto', flex: 'none',
              display: 'grid', gap: 'var(--space-2)',
              paddingTop: 'var(--space-3)',
              borderTop: '1px solid var(--border-default)'
            }}
          >
          <ChannelScope value={channels} onChange={setChannels} scope={scope} />

          {/* While dictating, the composer IS the recorder — the same box, a
              different state. A separate floating panel would leave a dead
              text field underneath it. */}
          {listening ? (
            <RecordingBar
              heard={heard}
              elapsed={elapsed}
              onCancel={cancelDictation}
              onFinish={finishDictation}
            />
          ) : (
          <div
            onClick={() => inputRef.current?.focus()}
            // Drag an image onto the composer. Same path as paste and the
            // attach button — one validation and read routine for all three.
            onDragOver={(e) => {
              if (![...(e.dataTransfer?.items || [])].some((it) => it.kind === 'file')) return
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={(e) => {
              // Fires when crossing into a child too, so ignore anything that
              // didn't actually leave the wrapper — otherwise the highlight
              // flickers as the cursor moves over the textarea.
              if (e.currentTarget.contains(e.relatedTarget)) return
              setDragging(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              addFiles(e.dataTransfer?.files)
            }}
            style={{
              display: 'grid', gap: 'var(--space-2)',
              padding: '14px 16px',
              // Rounded, not a pill. The composer is the one control a rep
              // returns to after every answer, so it should not read as a form
              // field among other form fields — but at 26px it was a lozenge,
              // and once the panel gained a solid header band and squared-off
              // field cards around it, that curve was the only thing on the
              // page shaped like it. 16px is the client's, and the same corner
              // the answer boxes above it carry.
              border: dragging
                ? '2px dashed var(--brand-primary)'
                : `1.5px solid ${composerFocused ? 'var(--brand-primary)' : 'var(--border-default)'}`,
              borderRadius: 16,
              background: dragging ? 'var(--tint-pine)' : '#fff',
              // Lifted on focus rather than ringed. The 4px ring read as an
              // error state on a green-accented page; a shadow that deepens
              // says "active" without borrowing a warning colour.
              boxShadow: dragging
                ? '0 0 0 4px rgba(22, 133, 95, 0.12)'
                : composerFocused
                  ? '0 4px 18px rgba(31, 36, 48, 0.10), 0 1px 3px rgba(31, 36, 48, 0.06)'
                  : '0 1px 3px rgba(31, 36, 48, 0.07)',
              transition: 'box-shadow 160ms ease, border-color 160ms ease',
              cursor: 'text'
            }}
          >
            {/* REPLY CONTEXT, inside the composer — a quoted strip above the
                text, the way a chat app shows what you are replying to. It was
                a separate bar above the box and read as a second input. The
                box stays empty for what the reply should say; this names the
                email and can be dismissed. */}
            {replyTo && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px 8px 12px',
                  borderLeft: '3px solid var(--accent-sky)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--tint-sky)'
                }}
              >
                <span className="ms" style={{ fontSize: 16, color: 'var(--accent-sky-text)', flex: 'none' }}>reply</span>
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{
                    fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
                    textTransform: 'uppercase', color: 'var(--accent-sky-text)'
                  }}>
                    Replying to
                  </span>
                  <span style={{
                    fontSize: 'var(--text-base)', color: 'var(--text-body)',
                    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis'
                  }}>
                    <strong style={{ color: 'var(--text-heading)' }}>{replyTo.subject || '(no subject)'}</strong>
                    {replyTo.senderName && <span style={{ color: 'var(--text-muted)' }}> · {replyTo.senderName}</span>}
                    {replyTo.when && <span style={{ color: 'var(--text-muted)' }}> · {replyTo.when}</span>}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setReplyTo(null)}
                  title="Not a reply after all"
                  aria-label="Cancel reply"
                  style={{
                    marginLeft: 'auto', flex: 'none', width: 24, height: 24,
                    border: 'none', borderRadius: 'var(--radius-pill)', background: 'transparent',
                    color: 'var(--text-muted)', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
                  }}
                >
                  <span className="ms" style={{ fontSize: 16 }}>close</span>
                </button>
              </div>
            )}
            <AttachmentThumbnails
              attachments={attachments}
              onView={setPreview}
              onRemove={removeAttachment}
            />

            {/* One row — textarea, attach, mic, send — matching the GHL
                reference and the portfolio Co-Pilot's own composer exactly.
                Attach used to sit alone on a second row below the text box;
                real Ask AI keeps every control on the same line as the
                input, attach and mic together immediately before send. */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-1)' }}>
              <textarea
                ref={inputRef}
                // The wrapper draws the focus border and ring; without this the
                // global :focus-visible rule adds a second one around the text.
                className="pp-focus-inherit"
                rows={1}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  // Grow with the content to a cap, so a long question stays
                  // visible while typing instead of scrolling inside one line.
                  const el = e.target
                  el.style.height = 'auto'
                  el.style.height = `${Math.min(el.scrollHeight, 132)}px`
                }}
                // Paste an image straight into the box — screenshot, then ⌘V.
                // See useAttachments.onPaste for the read/validate path this
                // shares with the attach button and drag-and-drop.
                onPaste={onPaste}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
                disabled={pending || available === false}
                placeholder={pending ? 'Reading the thread…' : replyTo ? 'What should the reply say?' : 'Ask anything about this deal…'}
                style={{
                  flex: 1, minWidth: 0, boxSizing: 'border-box',
                  minHeight: 28, maxHeight: 140, resize: 'none',
                  border: 'none', outline: 'none', background: 'transparent',
                  padding: 0,
                  // text-lg, not text-xl — matches the portfolio Co-Pilot's
                  // own composer exactly; this one ran visibly larger.
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-lg)',
                  lineHeight: 1.45, color: 'var(--text-heading)'
                }}
              />

              <input
                ref={fileRef}
                type="file"
                accept={ALLOWED_IMAGE_TYPES.join(',')}
                multiple
                onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
                style={{ display: 'none' }}
              />
              {/* Attach an image. A question AID — it tells the model what
                  you're asking about; claims still have to quote the thread. */}
              <IconButton
                icon="attach_file"
                size={34} iconSize={19}
                label={
                  attachments.length >= MAX_ATTACHMENTS
                    ? `${MAX_ATTACHMENTS} images is the limit`
                    : 'Attach an image to this question'
                }
                onClick={(e) => { e.stopPropagation(); fileRef.current?.click() }}
                disabled={
                  pending || available === false || attachments.length >= MAX_ATTACHMENTS
                }
              />

              <IconButton
                icon="mic"
                size={34} iconSize={19}
                label={
                  speechSupported
                    ? 'Dictate your question'
                    : 'Dictation needs Chrome, Edge or Safari'
                }
                onClick={startDictation}
                disabled={!speechSupported || pending || available === false}
              />

              {pending ? (
                // Same stop control as the portfolio Co-Pilot tab — GHL swaps
                // its send button for a stop button while a question is in
                // flight; this doesn't halt generation server-side (no
                // streaming), it abandons the wait client-side.
                <button
                  onClick={(e) => { e.stopPropagation(); stopAsking() }}
                  title="Stop"
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 34, height: 34, flex: 'none',
                    border: 'none', borderRadius: '50%',
                    background: 'var(--gray-800)', color: '#fff',
                    cursor: 'pointer'
                  }}
                >
                  <span className="ms" style={{ fontSize: 16 }}>stop</span>
                </button>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); submit() }}
                  disabled={!q.trim() || available === false}
                  // aria-label, not title: a native tooltip here would pop
                  // the same dark OS box beside the mic.
                  aria-label="Ask"
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    flex: 'none',
                    width: 34, height: 34, padding: 0,
                    border: 'none', borderRadius: '50%',
                    background: q.trim() && available !== false ? 'var(--brand-primary)' : 'var(--gray-200)',
                    color: q.trim() && available !== false ? '#fff' : 'var(--text-faint)',
                    cursor: q.trim() && available !== false ? 'pointer' : 'default'
                  }}
                >
                  <span className="ms" style={{ fontSize: 19 }}>arrow_upward</span>
                </button>
              )}
            </div>
          </div>
          )}
          </div>
        </div>
      </section>

    </div>
  )

  if (fullView) {
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Co-Pilot — full view"
        className="pp-portal"
        style={{
          position: 'fixed', inset: 0, zIndex: 900,
          background: '#fff'
        }}
      >
        {body}
      </div>,
      document.body
    )
  }

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        height: 560
      }}
    >
      {body}
    </div>
  )
}

// A starter as a chip: icon + short label, with the hint on hover.
//
// The old card carried a title and a description on two lines; a chip has room
// for neither, so `chipLabel` is the shortened form and the full question still
// goes into the composer when picked.
function PromptChip({ prompt, onPick }) {
  const accent = `var(--accent-${prompt.accent})`
  const tint = `var(--tint-${prompt.accent})`
  return (
    <button
      onClick={onPick}
      title={`${prompt.label} — ${prompt.hint}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        cursor: 'pointer',
        height: 36, padding: '0 16px 0 13px',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-pill)',
        background: '#fff',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
        fontWeight: 500,
        color: 'var(--text-body)',
        boxShadow: '0 1px 2px rgba(31, 36, 48, 0.05)',
        transition: 'background 160ms ease, border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = tint
        e.currentTarget.style.borderColor = accent
        e.currentTarget.style.boxShadow = '0 3px 10px rgba(31, 36, 48, 0.12)'
        e.currentTarget.style.transform = 'translateY(-1px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#fff'
        // --border-strong, matching the initial style. It restored
        // --border-default, so every chip faded a shade permanently after the
        // first hover and the row slowly lost its definition.
        e.currentTarget.style.borderColor = 'var(--border-strong)'
        e.currentTarget.style.boxShadow = '0 1px 2px rgba(31, 36, 48, 0.05)'
        e.currentTarget.style.transform = 'none'
      }}
    >
      <span className="ms" style={{ fontSize: 18, color: accent }}>{prompt.icon}</span>
      {prompt.chipLabel || prompt.label}
    </button>
  )
}

// One answer turn: coverage stamp, prose, clickable citations. Deliberately
// BORDERLESS — matching the portfolio Co-Pilot's AnswerTurn (CopilotTab.jsx)
// exactly, down to citation styling and where ReactionRow/ActionCard sit.
// This used to be its own bordered/left-accented card, which read as a
// different, boxed-in product sitting inside the shared embedded panel —
// the panel itself still keeps its own frame (Deal Hub's page layout,
// unrelated to this), but the ANSWER inside it is now identical to the
// portfolio tab's, with only the deal-specific additions (coverage stamp,
// Save as note/task) layered on in the same flat style rather than a
// separate card language.
//
// The coverage stamp is rendered above every AI output per spec §1F — it is
// computed server-side in app code, never asked of the model, so it cannot be
// hallucinated. It's also what makes a thin answer trustworthy: "read 6 of 8,
// 2 calls not transcribed" tells the rep why the answer is thin. It's Deal
// Hub's real equivalent of the portfolio tab's "Thought process" panel —
// askDeal.js has no tool-calling loop to narrate, so there are no tool
// steps to show, but there IS real coverage data, and it's now styled as
// the same kind of bare inline row ThoughtProcess uses rather than a
// tinted banner.
function Answer({ turn, onJumpToMessage, onInspect, people = [], onActionResolved }) {
  // 'note' | 'task' | null — which editor is open over this answer.
  const [saveAs, setSaveAs] = useState(null)

  // Did THIS turn already create a note or a task?
  //
  // Only a CONFIRMED action counts. A proposal still sitting on its card is
  // not a record yet, and a rejected or failed one never became one — in both
  // cases the rep may well want to write it by hand, so the button stays.
  const alreadyMade = useMemo(() => {
    const made = { note: false, task: false }
    for (const a of turn.proposedActions || []) {
      if (a.status !== 'confirmed') continue
      if (a.actionType === 'create_note') made.note = true
      if (a.actionType === 'create_task') made.task = true
    }
    return made
  }, [turn.proposedActions])

  const defaultContactId =
    people.find((p) => p.primary)?.id || people[0]?.id || null
  const cov = turn.coverage
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {cov && (
        <CoverageStamp
          coverage={cov}
          cached={turn.cached}
          readMessageIds={turn.readMessageIds}
          channelScope={turn.channelScope}
          onInspect={onInspect}
        />
      )}

      <div>
        <MarkdownAnswer text={turn.answerText} />

        {/* No "this answer has no quote" caveat.
            It fired whenever an answer carried zero citations — which is the
            NORMAL shape of plenty of sound answers: a count, a summary across
            the thread, or "no, nothing here says that". Reps saw a warning
            sitting under correct work, which teaches them to ignore warnings.
            The real guarantee is the opposite one and it still holds: a quote
            that IS shown has been checked character-for-character against its
            source (validate.js), and anything that failed was dropped before
            the answer was rendered. Absence of a quote is not evidence of a
            problem, so it is no longer presented as one. */}

        {/* A write the question also asked for — "attach this contact",
            "mark it lost", etc. Same ActionCard the portfolio Co-Pilot uses,
            same position relative to the reaction row (above it — a rep
            decides whether to confirm a proposal before rating the answer
            that surfaced it, not after). Nothing has reached GHL until a
            rep confirms this specific card. */}
        {turn.proposedActions?.length > 0 && (
          <div style={{ display: 'grid', gap: 8, margin: '9px 0 0' }}>
            {turn.proposedActions.map((a) => (
              <ActionCard
                key={a.actionId}
                actionId={a.actionId}
                actionType={a.actionType}
                proposed={a.proposed}
                // Same pair as the portfolio Co-Pilot: `status` so a reopened
                // thread shows a sent action as sent, and `onResolved` so the
                // outcome is written into the turn rather than living only in
                // the card. Without both, a remount offers an already-sent
                // email again with a live Confirm button.
                status={a.status || null}
                onResolved={(outcome) => onActionResolved?.(a.actionId, outcome)}
              />
            ))}
          </div>
        )}

        <ReactionRow runId={turn.runId} answerText={turn.answerText} />

        {/* Actions. Both write to the CRM, and both are now live.
            The answer text is pre-filled but editable — an agent's wording
            is a draft, and a rep saving it under their own name should be
            able to change it first. Deal-specific (a portfolio answer has
            no single deal to file a note/task against), styled as the same
            plain pill-button row PromptChip/ChannelScope already use. */}
        {turn.answered && (alreadyMade.note === false || alreadyMade.task === false) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
            {/* HIDDEN once this turn has already made one.
                The agent drafts a task, the rep confirms it, the card above
                says "Create task confirmed" — and this offered to create it
                again, one line below. Clicking it made a SECOND task with the
                same text, and nothing in the thread said the first one
                existed. Same for notes. */}
            {!alreadyMade.note && (
              <AnswerAction
                icon="sticky_note_2"
                label="Save as note"
                onClick={people.length ? () => setSaveAs('note') : undefined}
                disabledReason={
                  people.length ? null : 'This deal has no contacts, and a note is stored against one'
                }
              />
            )}
            {!alreadyMade.task && (
              <AnswerAction
                icon="task_alt"
                label="Create task"
                onClick={people.length ? () => setSaveAs('task') : undefined}
                disabledReason={
                  people.length ? null : 'This deal has no contacts, and a task is stored against one'
                }
              />
            )}
          </div>
        )}

        {/* CREATE, not edit — so no `note`/`task` prop. Passing one would put
            the editor in edit mode and PATCH a record that doesn't exist.
            initialBody seeds the text instead. */}
        {saveAs === 'note' && (
          <NoteEditor
            contacts={people}
            defaultContactId={defaultContactId}
            initialBody={draftFrom(turn)}
            onClose={() => setSaveAs(null)}
            onSaved={() => setSaveAs(null)}
          />
        )}
        {saveAs === 'task' && (
          <TaskEditor
            contacts={people}
            defaultContactId={defaultContactId}
            initialBody={draftFrom(turn)}
            onClose={() => setSaveAs(null)}
            onSaved={() => setSaveAs(null)}
          />
        )}
      </div>

      {/* Citations — same quote-pill style as the portfolio Co-Pilot's
          AnswerTurn: a left accent stripe on a quiet fill, not plain text.

          No "N quotes verified character-exact" line under them. It restated
          the mechanism on every single answer, directly beneath the quote it
          described — and a rep who can already see the quote and click through
          to its source gains nothing from being told how it got there. It also
          read "against its source message" under a quote from a TASK, which is
          simply wrong. Verification still happens (validate.js drops anything
          that fails); the quote's presence IS the evidence it passed. */}
      {turn.citations?.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {turn.citations.map((c, i) => (
            <button
              key={`${c.messageId}-${i}`}
              onClick={() => onJumpToMessage && onJumpToMessage(c.messageId)}
              title={onJumpToMessage ? 'Jump to this message in the timeline' : undefined}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 12px',
                border: 'none',
                borderLeft: '3px solid var(--accent-teal)',
                borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                background: 'var(--gray-50)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-base)', color: 'var(--text-muted)',
                fontStyle: 'italic',
                cursor: onJumpToMessage ? 'pointer' : 'default'
              }}
            >
              &ldquo;{c.quoteText}&rdquo;
              {c.sourceLabel && (
                <span style={{ fontStyle: 'normal' }}> — {c.sourceLabel}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// "Email · James Halloran · sent 9 Aug 2026", one line per distinct source
// message. Deduped: two quotes from the same email are one source, and listing
// it twice would overstate how much the answer rests on.
function sourceLines(citations) {
  const seen = new Set()
  const out = []
  for (const c of citations) {
    const line = c.sourceLabel
      ? `${c.sourceLabel}`
      : [c.channelLabel, c.senderName].filter(Boolean).join(' · ')
    if (!line || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

// An answer action. Live now that the note and task write paths exist; still
// refuses, with a reason, on a deal that has no contact to attach to.
function AnswerAction({ icon, label, onClick, disabledReason }) {
  const live = typeof onClick === 'function' && !disabledReason
  return (
    <button
      onClick={live ? onClick : undefined}
      disabled={!live}
      title={disabledReason || label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        cursor: live ? 'pointer' : 'not-allowed',
        height: 30, padding: '0 var(--space-3)',
        border: `1px solid ${live ? 'var(--border-strong)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-pill)',
        background: '#fff',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
        color: live ? 'var(--text-body)' : 'var(--text-faint)',
        opacity: live ? 1 : 0.7
      }}
    >
      <span className="ms" style={{ fontSize: 15 }}>{icon}</span>
      {label}
    </button>
  )
}

// The answer as plain text, for seeding a note or task.
//
// The field is turn.answerText — see where turns are built from res.answerText.
// Named draftFrom() rather than answerText() so the helper can't be confused
// with the property it reads.
//
// Citation markers are stripped: "[1]" means nothing outside this panel, and a
// note reading "we agreed the price [2]" in the CRM is worse than one without
// the marker. The sources are listed beneath instead, so the provenance
// survives in a form that still makes sense on its own.
function draftFrom(turn) {
  const body = String(turn.answerText || '')
    .replace(/\s*\[\d+\]/g, '')
    .trim()
  const sources = sourceLines(turn.citations || [])
  if (!sources.length) return body
  return `${body}\n\nSources:\n${sources.map((l) => `- ${l}`).join('\n')}`
}

// `confidence` is deliberately NOT a prop any more. The model still returns it
// and it is still stored on the run for evaluation — it is only no longer shown
// to a rep. A "medium confidence" pill next to a cited, verified answer read as
// a disclaimer on the whole answer, when the coverage line beside it already
// says the specific, useful thing: which messages were read and which were not.
function CoverageStamp({ coverage, cached, readMessageIds, channelScope, onInspect }) {
  const partial =
    coverage.messagesRead != null &&
    coverage.messagesTotal != null &&
    coverage.messagesRead < coverage.messagesTotal

  return (
    // Bare inline row — no banner background, no border — matching the
    // portfolio Co-Pilot's ThoughtProcess trigger row (same font weight,
    // same "just an icon and some text" treatment), rather than the tinted
    // full-bleed bar this used to be when it lived inside the Answer card.
    // The partial/unread signal still shows — as the eye icon and the
    // "N of M" count going gold-ish via unreadReasons below — just without
    // painting the whole row a different colour.
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap',
        fontSize: 'var(--text-md)', color: 'var(--text-muted)'
      }}
    >
      <span className="ms" style={{ fontSize: 17, color: 'var(--text-faint)' }}>
        {partial ? 'visibility_off' : 'visibility'}
      </span>
      <span
        title={
          readMessageIds?.length
            ? `Message ids read:\n${readMessageIds.join('\n')}`
            : undefined
        }
        style={{ cursor: readMessageIds?.length ? 'help' : 'default' }}
      >
        Read {coverage.messagesRead} of {coverage.messagesTotal}{' '}
        {coverage.messagesTotal === 1 ? 'message' : 'messages'}
      </span>
      {coverage.unreadReasons?.length > 0 && (
        // Muted, not clay. These reasons are ordinary facts about what was in
        // the thread — a call with no transcript, a message a rep deselected —
        // not problems with the answer. Painting them warning-orange beside a
        // "medium confidence" pill made a complete, cited answer look degraded.
        // Insights AI's equivalent row is one uniform muted tone; this matches it.
        <span>
          · {coverage.unreadReasons.join(' · ')}
        </span>
      )}
      {channelScope?.length > 0 && (
        <span
          title="This answer was scoped to these channels"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)',
            padding: '1px 7px', borderRadius: 'var(--radius-pill)',
            background: 'var(--tint-teal)', color: 'var(--accent-teal-text)',
            fontWeight: 600
          }}
        >
          <span className="ms" style={{ fontSize: 12 }}>filter_alt</span>
          {channelScope.map((c) => c.toUpperCase()).join(' · ')}
        </span>
      )}
      {onInspect && (
        <button
          onClick={onInspect}
          style={{
            border: 'none', background: 'none', padding: 0,
            cursor: 'pointer',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
            color: 'var(--text-link)', textDecoration: 'underline'
          }}
        >
          Show more
        </button>
      )}
      {cached && (
        <span style={{ marginLeft: 'auto', color: 'var(--text-faint)' }}>cached</span>
      )}
    </div>
  )
}

// Same loading language as the portfolio Co-Pilot tab — an animated icon and
// a plain inline label, not a bordered skeleton card. Deal Hub's askDeal.js
// has no tool-calling loop to narrate (no "Generating…" second phase to
// distinguish, unlike the portfolio's ThoughtProcess), so this only ever
// shows the single "Reading the thread…" phase — still true the whole time
// a question is in flight here, and honest about not knowing more than that.
function Thinking() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      fontSize: 'var(--text-md)', color: 'var(--text-muted)'
    }}>
      <span
        className="ms"
        style={{ fontSize: 17, animation: 'pp-think 1.4s ease-in-out infinite' }}
      >
        hourglass_top
      </span>
      Reading the thread…
    </span>
  )
}

// Per-question channel scope. "Ask about SMS only" without touching the
// standing inclusion state the timeline checkboxes drive — two different
// ideas, so two different controls.
//
// Nothing selected means every channel, which is why there's no explicit
// "All" chip: an empty selection already says it, and an All chip that
// deselects everything else invites the "did I mean none?" confusion.
const SCOPE_CHANNELS = [
  ['email', 'Email', 'mail'],
  ['sms', 'SMS', 'sms'],
  ['whatsapp', 'WhatsApp', 'chat'],
  ['call', 'Calls', 'call'],
  ['note', 'Notes', 'sticky_note_2'],
  // Tasks are evidence too (rule 7). Without this chip the row implied the
  // agent doesn't read them, and there was no way to scope a question to them.
  ['task', 'Tasks', 'task_alt']
]

function ChannelScope({ value, onChange, scope }) {
  const toggle = (key) =>
    onChange(value.includes(key) ? value.filter((v) => v !== key) : [...value, key])

  const counts = scope?.byChannel || {}
  // Notes aren't a message channel in the payload — they're separate evidence
  // — so their count comes from its own field.
  // Notes and tasks aren't message channels in the payload — they're separate
  // evidence kinds, so their counts come from their own fields.
  const countFor = (key) =>
    key === 'note' ? scope?.notes ?? null
      : key === 'task' ? scope?.tasks ?? null
        : counts[key] ?? null

  // How many messages this question will actually read. Nothing selected means
  // everything, which is the number a rep most wants to see before asking.
  const selectedCount = value.length === 0
    ? scope?.readable ?? null
    : value.reduce((n, k) => n + (countFor(k) || 0), 0)

  // Only offer channels that exist on this deal — a chip reading "Email · 0"
  // is a dead end, and offering it invites an empty answer.
  const available = SCOPE_CHANNELS.filter(([key]) => {
    if (!scope) return true          // pre-load: show all rather than flicker
    return (countFor(key) || 0) > 0
  })

  if (scope && available.length === 0) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span
        style={{
          fontSize: 'var(--text-sm)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
          textTransform: 'uppercase', color: 'var(--text-muted)', marginRight: 2
        }}
      >
        Ask about
      </span>
      {available.map(([key, label, icon]) => {
        const on = value.includes(key)
        const n = countFor(key)
        return (
          <button
            key={key}
            onClick={() => toggle(key)}
            title={
              n != null
                ? `${n} ${label} message${n === 1 ? '' : 's'} the AI can read — ` +
                  'excludes unticked rows and calls without a transcript, so this ' +
                  'can be lower than the timeline filter above'
                : undefined
            }
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              cursor: 'pointer',
              // Between the tags they were (26px/text-sm) and the prompt
              // chips above (36px): the design draws these at roughly three
              // quarters of a chip, which is 28px at text-base.
              height: 28, padding: '0 12px',
              border: on ? '1.5px solid var(--accent-teal)' : '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-pill)',
              background: on ? 'var(--tint-teal)' : '#fff',
              color: on ? 'var(--accent-teal)' : 'var(--text-muted)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-base)', fontWeight: on ? 600 : 400
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>{icon}</span>
            {label}
            {n != null && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)',
                  opacity: 0.75
                }}
              >
                {n}
              </span>
            )}
          </button>
        )
      })}

      {/* The number that matters: what this question will read. */}
      {selectedCount != null && (
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)',
            fontSize: 'var(--text-sm)', fontWeight: 600,
            color: selectedCount === 0 ? 'var(--status-stuck)' : 'var(--text-muted)'
          }}
        >
          <span className="ms" style={{ fontSize: 13 }}>visibility</span>
          {/* "items", not "messages". This counts every kind of evidence the
              question will read — messages, notes AND tasks (see `scope`, which
              increments `readable` for all three). On a deal with 2 tasks and no
              messages it read "2 messages (all channels)" directly under a
              coverage line saying "Read 0 of 0 messages", which is a flat
              contradiction: one was counting messages, the other everything. */}
          {selectedCount} item{selectedCount === 1 ? '' : 's'}
          {value.length === 0 && ' (everything on this deal)'}
        </span>
      )}

      {value.length > 0 && (
        <button
          onClick={() => onChange([])}
          style={{
            border: 'none', background: 'none', padding: 0, cursor: 'pointer',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
            color: 'var(--text-link)', textDecoration: 'underline'
          }}
        >
          clear
        </button>
      )}

      {/* Excluded / unreadable messages are worth naming here too, so a low
          count doesn't look like missing data. */}
      {scope?.coverage?.unreadReasons?.length > 0 && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-clay)' }}>
          · {scope.coverage.unreadReasons.join(' · ')}
        </span>
      )}
    </div>
  )
}

// "What did this answer actually read?" — resolved from the ids stored on the
// run, not recomputed from the deal. So an old chat shows what it truly read
// even after the thread has grown or the inclusion state changed.
function MessagesConsideredModal({ runId, onClose, onJumpToMessage }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    aiAPI.runMessages(runId)
      .then((r) => alive && setData(r))
      .catch((e) => alive && setErr(e.message || 'Could not load messages'))
    return () => { alive = false }
  }, [runId])

  // Escape to close — a modal you can only dismiss by aiming at a small × is
  // a modal people fight with.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        background: 'rgba(31, 36, 48, 0.45)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)', maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          borderRadius: 'var(--radius-lg)',
          background: '#fff', boxShadow: 'var(--shadow-overlay)',
          overflow: 'hidden'
        }}
      >
        <header
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '14px var(--space-4)',
            borderBottom: '1px solid var(--border-default)',
          background: 'var(--panel-tint, var(--gray-25))'
          }}
        >
          <span className="ms" style={{ fontSize: 20, color: 'var(--accent-teal)', marginTop: 1 }}>
            visibility
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>
              Messages considered
            </h3>
            {data && (
              <p style={{ margin: '3px 0 0', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                {data.items.length} of {data.messagesTotal} on this deal
                {data.unreadReasons?.length > 0 && ` · ${data.unreadReasons.join(' · ')}`}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none', background: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', padding: 2
            }}
          >
            <span className="ms" style={{ fontSize: 20 }}>close</span>
          </button>
        </header>

        {data?.question && (
          <p
            style={{
              margin: 0, padding: '10px var(--space-4)',
              borderBottom: '1px solid var(--border-default)',
              background: 'var(--gray-50)',
              fontSize: 'var(--text-md)', color: 'var(--text-body)'
            }}
          >
            <strong style={{ fontWeight: 600 }}>Asked:</strong> {data.question}
          </p>
        )}

        <div style={{ overflowY: 'auto', padding: 'var(--space-2) 0' }}>
          {err && (
            <p style={{ margin: 0, padding: 16, fontSize: 'var(--text-md)', color: 'var(--status-stuck)' }}>
              {err}
            </p>
          )}
          {!data && !err && (
            <p style={{ margin: 0, padding: 16, fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
              Loading…
            </p>
          )}
          {data?.items?.length === 0 && (
            <p style={{ margin: 0, padding: 16, fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
              This answer read no messages — it was based on the deal facts alone.
            </p>
          )}
          {data?.items?.map((m) => (
            <button
              key={`${m.kind}-${m.id}`}
              onClick={() => {
                if (m.kind === 'message' && onJumpToMessage) {
                  onJumpToMessage(m.id)
                  onClose()
                }
              }}
              style={{
                display: 'grid', gap: 3, width: '100%', textAlign: 'left',
                padding: '10px var(--space-4)',
                border: 'none',
                borderBottom: '1px solid var(--border-default)',
                background: '#fff',
                cursor: m.kind === 'message' && onJumpToMessage ? 'pointer' : 'default',
                fontFamily: 'var(--font-sans)'
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
                    textTransform: 'uppercase',
                    padding: '2px 6px', borderRadius: 'var(--radius-sm)',
                    background: 'var(--gray-100)', color: 'var(--text-muted)'
                  }}
                >
                  {m.channel}
                </span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  {m.direction === 'in' ? 'In ←' : '→ Out'}
                </span>
                <span style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-heading)' }}>
                  {m.who}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
                  {shortDate(m.at)}
                </span>
              </span>
              <span
                style={{
                  fontSize: 'var(--text-base)', lineHeight: 1.45, color: 'var(--text-body)',
                  display: '-webkit-box', WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical', overflow: 'hidden'
                }}
              >
                {m.body || '(no readable text)'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function shortDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
