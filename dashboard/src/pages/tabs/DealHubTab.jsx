import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import PanelHead, { PanelHeadButton } from '../dealhub/PanelHead'
import { formatMoney } from '../../utils/money'
import Timeline from '../dealhub/Timeline'
import MessageComposer from '../dealhub/MessageComposer'
import PeopleSection from '../dealhub/PeopleSection'
import DealSection, { CardToolbar, StatusPill } from '../dealhub/DealSection'
import MediaSection from '../dealhub/MediaSection'
import AskDeal from '../dealhub/AskDeal'
import QualificationSection from '../dealhub/QualificationSection'
import { DealTasksSection, DealNotesSection } from '../dealhub/DealTasksSection'
import {
  DealHubSkeleton, DealBodySkeleton
} from '../dealhub/Skeleton'
import { dealsAPI } from '../../api/deals'
import { aiAPI } from '../../api/ai'
import { Truncate } from '../shared/ListChrome'

// Deal Hub tab — the core view.
//
// Behaviour:
//   • On mount (or when the selected dealId is null), fetch the list of open
//     deals for the location and auto-select the first one. This is Option B
//     from the design conversation: users always land on a real deal, not an
//     empty state.
//   • Deal-switcher dropdown at the top lets users change deal in-place
//     without leaving the tab.
//   • Filter chips (people + channels + inclusion) narrow the timeline
//     client-side per rule 7 — never a round-trip.

// Chip presentation order — keep the fixed order across deals so users
// don't hunt for a channel that moved position. We just skip channels
// that don't exist on the current deal.
const CHANNEL_CHIPS = [
  ['Email',    'EMAIL'],
  ['WhatsApp', 'WHATSAPP'],
  ['SMS',      'SMS'],
  ['iMessage', 'IMESSAGE'],
  ['Call',     'CALL'],
  ['Note',     'NOTE'],
  // A colleague's comment on the conversation in GHL's inbox — seen by the
  // team, never by the customer. Beside Note because that is what it is.
  ['Internal comment', 'INTERNAL'],
  ['Task',     'TASK'],
  // A CUSTOM message whose provider we could not resolve. Rare, but without a
  // chip those rows are unreachable: they'd count toward All and no filter
  // would ever show them on their own.
  ['Custom',   'CUSTOM'],
  // Last: it's the least-read row type, and it's the one you filter TO
  // deliberately rather than scan past.
  ['Activity', 'ACTIVITY']
]

// Which filter bucket a message belongs to.
//
// A message sent through a CUSTOM conversation provider — goghl.ai's WhatsApp,
// for instance — normalises to channel 'CUSTOM'. Bucketing all of those
// together produced one generic "Custom" chip that told a rep nothing about
// what the messages actually were. Key on the provider instead, so goghl.ai
// gets its own chip named after itself.
function channelKeyOf(m) {
  if (m.channel === 'CUSTOM' && m.providerName) {
    return `PROVIDER:${m.providerName}`
  }
  return m.channel
}

// The fixed channel chips, plus one per custom provider this deal actually
// used. Providers are appended rather than interleaved so the standard channels
// stay in their usual positions.
function chipsFor(counts) {
  const providers = [...counts.keys()]
    .filter((k) => k.startsWith('PROVIDER:'))
    .sort()
    .map((k) => [k.slice('PROVIDER:'.length), k])
  return [...CHANNEL_CHIPS, ...providers]
}

// Timeline rows per page for infinite scroll. Most deals fit in one page, so
// for them nothing changes; a long deal loads its history as the rep scrolls
// up towards it.
const TIMELINE_PAGE = 50

const tsOf = (m) => { const v = new Date(m?.ts).getTime(); return Number.isNaN(v) ? 0 : v }

// Names for a sent message's recipients, from the deal's people — the same
// decoration every load applies.
function decorateRows(list, people) {
  const nameById = Object.fromEntries(
    (people || []).map((p) => [p.id, p.firstName || p.lastName || 'Contact'])
  )
  return (list || []).map((m) => ({
    ...m,
    toNames: (m.toIds || []).map((cid) => nameById[cid]).filter(Boolean)
  }))
}

export default function DealHubTab({
  dealId, onSwitchDeal, onOpenBusiness, onOpenContact, onOpenTab, onEditDealRecord,
  // Landing on the first deal because none was selected is not a move the rep
  // made, so it must not become a step the Back button walks through. Setting
  // the deal without recording history is what this is for; every other switch
  // goes through onSwitchDeal.
  onAutoSelectDeal
}) {
  // Deal list for the switcher dropdown
  const [deals, setDeals] = useState(null)
  // How many open deals exist, and where the next page starts. The list route
  // has always returned both — the switcher just never read them, so it
  // showed the first page and implied that was everything.
  const [dealsTotal, setDealsTotal] = useState(null)
  const [dealsOpen, setDealsOpen] = useState(null)
  const [dealsCursor, setDealsCursor] = useState(null)
  const [loadingMoreDeals, setLoadingMoreDeals] = useState(false)
  const [dealsError, setDealsError] = useState(null)

  // The one active deal
  const [deal, setDeal] = useState(null)
  const [stages, setStages] = useState(null)
  // A reply request for the Co-Pilot composer. The timeline's Reply now opens
  // a composer inside the thread instead, so nothing sets this today; AskDeal
  // still accepts it until Co-Pilot sending is removed.
  const [askSeed] = useState(null)

  // Refetch the TIMELINE ONLY — not the deal, stages or siblings — and
  // re-apply the same toNames decoration the first load does. Used after a
  // confirmed send: GHL delivers the sent message back to us by webhook a
  // second or two later, and until this ran the rep had to reload the page
  // to see their own message in the thread.
  //
  // PAGED since infinite scroll: this refetches the NEWEST page and merges it
  // over what is loaded. Rows inside that page's time range are replaced by
  // the server's (a message moved off the deal drops out); older pages the
  // rep has scrolled into are kept.
  const refreshTimeline = useCallback(async () => {
    if (!dealId) return
    try {
      const t = await dealsAPI.timeline(dealId, { limit: TIMELINE_PAGE })
      const fresh = decorateRows(t.messages, deal?.people)
      const ids = new Set(fresh.map((m) => m.id))
      const cutoff = t.hasMore && fresh.length ? tsOf(fresh[fresh.length - 1]) : -Infinity
      // The older-page cursor is left alone: what was loaded stays loaded, so
      // the next page is still the one before the oldest row on screen.
      setMessages((prev) => [
        ...fresh,
        ...(prev || []).filter((m) => !ids.has(m.id) && tsOf(m) < cutoff)
      ])
    } catch { /* the next interaction reloads; a missed refresh is not an error */ }
  }, [dealId, deal?.people])

  // INFINITE SCROLL — the cursor for the next (older) page. A ref mirrors the
  // state so the callbacks below read the current value without re-binding.
  const [olderState, setOlderState] = useState({ hasMore: false, before: null, loading: false })
  const timelineMore = useRef({ hasMore: false, before: null, loading: false, loaded: false })
  const setTimelinePaging = (t) => {
    const next = { hasMore: !!t?.hasMore, before: t?.nextBefore || null, loading: false, loaded: false }
    timelineMore.current = next
    setOlderState(next)
  }

  // Fetch the page before the oldest loaded row and append it.
  const loadOlder = useCallback(async () => {
    const cur = timelineMore.current
    if (!dealId || !cur.hasMore || cur.loading) return
    timelineMore.current = { ...cur, loading: true }
    setOlderState(timelineMore.current)
    try {
      const t = await dealsAPI.timeline(dealId, { limit: TIMELINE_PAGE, before: cur.before })
      const older = decorateRows(t.messages, deal?.people)
      setMessages((prev) => {
        const have = new Set((prev || []).map((m) => m.id))
        return [...(prev || []), ...older.filter((m) => !have.has(m.id))]
      })
      const next = { hasMore: !!t.hasMore, before: t.nextBefore || null, loading: false, loaded: !t.hasMore }
      timelineMore.current = next
      setOlderState(next)
    } catch {
      // Leave hasMore on, so scrolling up tries again.
      timelineMore.current = { ...cur, loading: false }
      setOlderState(timelineMore.current)
    }
  }, [dealId, deal?.people])

  // Everything still unloaded, in one go — for Select all, which must cover
  // the whole deal: unticking "all" while older pages sat unloaded would
  // leave them ticked, and Co-Pilot would read rows the rep believed off.
  const loadAllOlder = useCallback(async () => {
    let cur = timelineMore.current
    const extra = []
    while (dealId && cur.hasMore) {
      const t = await dealsAPI.timeline(dealId, { limit: 200, before: cur.before })
      extra.push(...decorateRows(t.messages, deal?.people))
      cur = { hasMore: !!t.hasMore, before: t.nextBefore || null, loading: false, loaded: !t.hasMore }
    }
    timelineMore.current = cur
    setOlderState(cur)
    return extra
  }, [dealId, deal?.people])

  // After a confirmed send, look for the webhook twice: most land inside
  // 2.5s; a slower provider lands by 6s. Two cheap GETs, no polling loop.
  const onActionConfirmed = useCallback((actionType) => {
    if (actionType !== 'send_message') return
    window.setTimeout(refreshTimeline, 2500)
    window.setTimeout(refreshTimeline, 6000)
  }, [refreshTimeline])

  // Same wait after a send from a timeline composer.
  const refreshAfterSend = useCallback(() => {
    window.setTimeout(refreshTimeline, 2500)
    window.setTimeout(refreshTimeline, 6000)
  }, [refreshTimeline])
  const [messages, setMessages] = useState(null)
  // The channel the conversation last ran on: the newest real message —
  // not a note, task, event or internal comment — with its sender, so the
  // composer opens on WhatsApp QR when that is what the thread is on.
  const lastChannel = useMemo(() => {
    const m = (messages || []).find((x) =>
      !x.event && x.kind !== 'note' && x.kind !== 'task'
      && x.channel && !['INTERNAL', 'NOTE', 'TASK', 'ACTIVITY', 'SYSTEM'].includes(x.channel))
    if (!m) return null
    return { channel: m.channel, providerId: m.providerIsNative ? null : (m.providerId || null) }
  }, [messages])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Left-rail tabs — Deal / People / Media. Deal comes first and is the
  // default: it's the record the whole page is about, and the header the rep
  // reads before anything else. Media is still to come.
  const [leftRail, setLeftRail] = useState('deal')

  // Sibling open deals on the same contact — powers the "other open deals"
  // chips in the Deal section. Reuses the reassignment-targets endpoint,
  // which already answers exactly this question (every open opp on the
  // contact) and includes the current deal, which DealSection filters out.
  const [siblingDeals, setSiblingDeals] = useState([])


  // Filter state.
  //
  // An ARRAY of selected buckets, not one value. Picking Note used to clear
  // Task, so "notes and tasks, but not the emails" was unreachable — the only
  // way to see both was All, which brought the whole thread with it. Empty
  // array = no channel filter = everything, which is what the All chip sets.
  const [channelFilter, setChannelFilter] = useState([])
  const [peopleFilter, setPeopleFilter] = useState([])
  // null = all, true = included only, false = excluded only.

  // Deal switcher dropdown open/close
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [switcherQ, setSwitcherQ] = useState('')
  const switcherRef = useRef(null)

  // Picklist choices for the five opportunity custom fields, so those chips can
  // be dropdowns rather than read-only text. Location-wide and rarely changing,
  // so fetched once rather than per deal.
  // Deals matching what is typed into the switcher, from the SERVER.
  //
  // It used to filter the cached `deals` array client-side. That array is one
  // page — the client asks for 200 and the server caps at 100 — so on a
  // location with 356 open deals the switcher could only ever find the first
  // 100, and reported "0 of 100 match" for anything outside them. Searching
  // by contact email failed even within those, because the server matched
  // o.name alone.
  const [switcherHits, setSwitcherHits] = useState(null)
  const [switcherBusy, setSwitcherBusy] = useState(false)

  const [fieldOptions, setFieldOptions] = useState({})
  useEffect(() => {
    let alive = true
    dealsAPI.customFieldOptions()
      .then((r) => { if (alive) setFieldOptions(r.fields || {}) })
      // A failure here costs the dropdowns, not the page — the chips fall back
      // to read-only, which is what they were before.
      .catch(() => {})
    return () => { alive = false }
  }, [])


  // Ask the SERVER as the rep types. Debounced, and the response is discarded
  // if a newer query has been started — typing fast otherwise leaves an
  // earlier query's results on screen.
  useEffect(() => {
    const q = switcherQ.trim()
    if (!q) { setSwitcherHits(null); setSwitcherBusy(false); return }
    setSwitcherBusy(true)
    let alive = true
    const t = window.setTimeout(() => {
      // status 'all', not 'open': a rep searching by name is often looking
      // for a deal they have already won or lost, and the switcher's default
      // list being open-only should not narrow an explicit search.
      dealsAPI.list({ q, status: 'all', limit: 50 })
        .then((res) => { if (alive) setSwitcherHits(res.deals || []) })
        .catch(() => { if (alive) setSwitcherHits([]) })
        .finally(() => { if (alive) setSwitcherBusy(false) })
    }, 250)
    return () => { alive = false; window.clearTimeout(t) }
  }, [switcherQ])

  // Load the deal list once — used by the switcher and the auto-select.
  useEffect(() => {
    let alive = true
    // 100 is the server's MAX_LIMIT — asking for 200 silently got 100 back,
    // which then read as "that is all of them". Ask for what we can have and
    // page for the rest.
    // EVERY status, not just open.
    //
    // The switcher listed open deals only, so a rep who wanted a won deal had
    // to know to type its name — the list itself never offered it, and the
    // search finding deals the list did not show read as a bug. The header
    // now says how many of the total are open, so nothing is hidden and the
    // useful subset is still called out.
    dealsAPI.list({ status: 'all', limit: 100 })
      .then((res) => {
        if (!alive) return
        setDeals(res.deals || [])
        setDealsTotal(res.totalCount ?? null)
        setDealsOpen(res.openCount ?? null)
        setDealsCursor(res.hasMore ? res.nextCursor : null)
        // Auto-select the first open deal if none is selected yet.
        if (!dealId && res.deals && res.deals.length > 0) {
          const select = onAutoSelectDeal || onSwitchDeal
          select(res.deals[0].id)
        }
      })
      .catch((err) => alive && setDealsError(err.message || 'Failed to load deals'))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the currently-selected deal.
  useEffect(() => {
    if (!dealId) return
    let alive = true
    setLoading(true)
    setError(null)
    setStages(null)
    setSiblingDeals([])
    Promise.all([
      dealsAPI.get(dealId),
      // The newest page only; older pages load as the rep scrolls up.
      dealsAPI.timeline(dealId, { limit: TIMELINE_PAGE }),
      dealsAPI.stages(dealId),
      // Siblings are decoration on one column — a failure here must not
      // take the whole deal view down with it.
      dealsAPI.reassignmentTargets(dealId).catch(() => ({ targets: [] }))
    ])
      .then(([d, t, s, r]) => {
        if (!alive) return
        setDeal(d)
        setStages(s.stages || [])
        setSiblingDeals(r.targets || [])
        setMessages(decorateRows(t.messages, d.people))
        setTimelinePaging(t)
        setLoading(false)
        // Reset filters when the deal changes.
        setChannelFilter([])
        setPeopleFilter([])
      })
      .catch((err) => {
        if (!alive) return
        // A RESTORED dealId that no longer resolves — won/lost/archived
        // differently since the last visit, deleted in GHL, or simply left
        // over in localStorage's pp.position.<locationId> with no expiry —
        // used to render as a dead end: "Select a deal…" in the switcher (the
        // fetch never set `deal`) sitting above a flat "Deal not found" error.
        // The rep's only way out was the dropdown they were already looking
        // at failing to help, because it has nothing to show until a search
        // is typed.
        //
        // Same rule as the empty-dealId case on mount (Option B — land on a
        // REAL deal, never an empty or broken one): on a 404 specifically,
        // fall back to the first open deal instead of showing the error.
        // Anything else (network failure, 500, auth) is a real problem and
        // must still be shown — silently swapping deals under a genuine
        // server error would hide it.
        if (err.status === 404) {
          const select = onAutoSelectDeal || onSwitchDeal
          if (deals && deals.length > 0) {
            if (deals[0].id !== dealId) {
              select(deals[0].id)
            } else {
              // The "first" deal IS the one that just 404'd — a stale list,
              // not a stale dealId. Selecting it again would refire this same
              // effect with the same outcome. Show the error instead of
              // spinning forever.
              setError(err.message || 'Failed to load deal')
              setLoading(false)
            }
            return
          }
          // The deals list has not resolved yet — both effects fire on
          // mount in parallel, and this one can win the race. Fetch a fresh
          // first page rather than wait on state from the other effect.
          dealsAPI.list({ status: 'all', limit: 1 })
            .then((res) => {
              if (!alive) return
              const first = res.deals && res.deals[0]
              if (first && first.id !== dealId) select(first.id)
              else {
                setError('No deals found for this account')
                setLoading(false)
              }
            })
            .catch(() => {
              if (!alive) return
              setError(err.message || 'Failed to load deal')
              setLoading(false)
            })
          return
        }
        setError(err.message || 'Failed to load deal')
        setLoading(false)
      })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId])

  // Close the switcher on outside click. Also clear its search when closed
  // so the next open starts fresh.
  useEffect(() => {
    if (!switcherOpen) {
      if (switcherQ) setSwitcherQ('')
      return
    }
    const handler = (e) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target)) {
        setSwitcherOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switcherOpen])

  // Field writes from the Deal card. One field at a time: the card has no Save
  // button of its own, and a picker or dropdown commits the moment it changes.
  //
  // Nothing is written locally — opportunities have full webhook coverage and
  // stage_history is maintained only by that path (see the server's
  // ghlOpportunityWrite.js). So the value shown is updated optimistically and
  // rolled back on failure; the webhook reconciles a moment later.
  const [savingField, setSavingField] = useState(null)
  const [saveError, setSaveError] = useState(null)
  // Names the field just written, so the card can confirm it. Without this a
  // save was completely silent on success — only failures said anything.
  const [savedField, setSavedField] = useState(null)

  // CRM users for the Owner picker on the deal card.
  //
  // Lazy and once: the list is location-wide, changes rarely, and a rep who
  // never reassigns an owner should not pay for it. Same shape as the Deals
  // tab's reference fetch.
  const [users, setUsers] = useState(null)
  const loadUsers = useCallback(() => {
    if (users !== null) return
    dealsAPI.users()
      .then((r) => setUsers(r?.users || []))
      // An empty list renders the picker disabled with a reason, rather than
      // an empty dropdown.
      .catch(() => setUsers([]))
  }, [users])

  // GHL's own lost-reason picklist. Lazy like `users`: only a manager marking
  // a deal lost ever needs it, and most Deal Hub visits never do.
  const [lostReasons, setLostReasons] = useState(null)
  const loadLostReasons = useCallback(() => {
    if (lostReasons !== null) return
    dealsAPI.lostReasons()
      .then((r) => setLostReasons(r?.reasons || []))
      // An empty list shows "No lost reasons configured in your CRM" rather
      // than an empty dropdown — the free-text reason still works.
      .catch(() => setLostReasons([]))
  }, [lostReasons])

  const saveDealField = async (field, value) => {
    if (savingField) return
    // Custom fields are keyed by their GHL id, so the right picker shows
    // progress rather than all five at once.
    setSavingField(field === 'customField' ? value.id : field)
    setSaveError(null)
    const before = deal
    const beforeStages = stages
    // Paint the picked stage immediately, before the request — same
    // reasoning as the customField branch below: the round trip + the
    // delayed reconcile (see the setTimeout further down) together take
    // ~2.5s+, and without this the stepper showed the OLD stage that whole
    // time even though the picker's own dropdown already reflected the
    // pick. A side effect ahead of the try/save, not its own branch, so it
    // doesn't short-circuit the actual dealsAPI.update call below.
    if (field === 'pipelineStageId') {
      setStages((prev) => (prev || []).map((s) => ({ ...s, isCurrent: s.id === value })))
    }
    try {
      let res
      if (field === 'customField') {
        // Paint the new value BEFORE the request, not after.
        //
        // This setDeal used to sit after the await, so the chip kept showing
        // the old value for the whole ~700ms round trip to GHL and picking felt
        // slow. The catch block restores `before`, so painting early is safe:
        // a failed save rolls the chip back.
        //
        // `dealKey` is the camelCase property the card renders from; the picker
        // passes it because only it knows which chip was edited. `|| null`
        // because clearing a multi-select yields [], which joins to '' — and an
        // empty string reads as "set" to the chip, so it would render blank
        // rather than "Not set".
        if (value.dealKey) {
          setDeal((d) => d && {
            ...d,
            [value.dealKey]: (Array.isArray(value.value)
              ? value.value.join(', ')
              : value.value) || null
          })
        }

        // QUALIFICATION rows paint early too. They live in their own array
        // rather than on a dealKey, and the reconcile below is a deliberate
        // 2.5s later — without this the heading a rep just filled kept
        // showing "Not filled yet" for that whole time, which reads as a
        // failed save. The refetch still replaces it with whatever GHL
        // normalised.
        setDeal((d) => {
          if (!d?.qualification?.length) return d
          const text = Array.isArray(value.value) ? value.value.join(', ') : value.value
          return {
            ...d,
            qualification: d.qualification.map((q) => (
              q.fieldId && q.fieldId === value.id
                ? { ...q, value: text || null, filled: !!(text && String(text).trim()) }
                : q
            ))
          }
        })

        res = await dealsAPI.update(dealId, {
          customFields: [{ id: value.id, field_value: value.value }]
        })

        // GHL takes customFields as a list of { id, field_value }. One field
        // at a time: each picker commits on its own, and sending the whole set
        // would overwrite fields the rep never touched.
        //
        // Reconcile once the webhook has had time to land, so anything GHL
        // normalised replaces the optimistic value. NOT an immediate refetch —
        // that lost a race it could never win: our PUT goes to GHL, GHL fires a
        // webhook, the handler fetches the opportunity back and only then
        // writes our row, so a GET issued microseconds later returns the OLD
        // value and the chip fell back to "Not set".
        //
        // MERGED, NOT REPLACED. 2.5s is a guess at a round trip we do not
        // control — our PUT to GHL, GHL's webhook to us, then the handler's
        // OWN getOpportunityFull call back to GHL. When that guess is wrong
        // the response is the pre-edit row, and `setDeal(fresh)` wholesale
        // put EVERY field back: a rep cleared one chip, watched it read "Not
        // set", and then saw the old value return along with anything else
        // they had changed in the last few seconds.
        //
        // So the fields this turn touched are pinned over the refetch. They
        // are the ones we know we sent and the server may not have yet; every
        // other field still comes from the server, which is the point of
        // reconciling at all. The next refetch — a reload, a tab switch —
        // carries no pins and shows the settled truth.
        const pinnedId = value.id
        const pinnedKey = value.dealKey || null
        const pinnedText = (Array.isArray(value.value)
          ? value.value.join(', ')
          : value.value) || null
        window.setTimeout(() => {
          dealsAPI.get(dealId).then((fresh) => {
            if (!fresh) return
            setDeal((cur) => {
              if (!cur) return fresh
              const merged = { ...fresh }
              // The chip's own property, when it has one.
              if (pinnedKey && fresh[pinnedKey] !== pinnedText) {
                merged[pinnedKey] = pinnedText
              }
              // And the qualification row, which lives in its own array.
              if (pinnedId && Array.isArray(fresh.qualification)) {
                merged.qualification = fresh.qualification.map((q) => (
                  q.fieldId === pinnedId
                    ? { ...q, value: pinnedText, filled: !!(pinnedText && String(pinnedText).trim()) }
                    : q
                ))
              }
              return merged
            })
          })
            .catch(() => {})
            // Settled — or we failed to re-read, in which case the optimistic
            // value is the best we have and holding a spinner over it for
            // ever would be worse than showing it.
            .finally(() => setSavingField((cur) => (cur === pinnedId ? null : cur)))
        }, 2500)
      } else if (field === 'status') {
        // Its own endpoint — the only one that records a lost reason, and the
        // only one that files the outcome reason in the right custom field.
        const next = value?.status ?? value
        const r = await dealsAPI.setStatus(dealId, next, {
          lostReasonId: value?.lostReasonId,
          reason: value?.reason
        })
        // The status and the reason are separate GHL calls. ok:true with a
        // reasonError means the deal DID close but the reason did not save —
        // surface that instead of a silent success.
        setDeal((d) => d && {
          ...d,
          status: next,
          outcomeReason: r?.reasonSaved ? (value?.reason || null) : (d.outcomeReason ?? null)
        })
        if (r?.reasonError) throw new Error(r.reasonError)
      } else if (field === 'pipeline') {
        // A pipeline move: pipelineId AND the target's first stage in ONE
        // request — GHL rejects a stage that is not in the pipeline it is
        // sent with, so the two cannot go as separate writes. Painted
        // first, like a stage change: the stage picker and stepper swap to
        // the new pipeline's stages immediately, and the 2.5s reconcile
        // below replaces this guess with the server's own stage rows
        // (isPast, enteredAt and the rest). The catch block restores
        // `beforeStages` if the write fails.
        setDeal((d) => d && {
          ...d,
          pipelineId: value.pipelineId,
          pipelineName: value.pipelineName,
          stageId: value.pipelineStageId
        })
        setStages((value.stages || []).map((st) => ({
          id: st.id, name: st.name, isActive: true,
          isCurrent: st.id === value.pipelineStageId, isPast: false
        })))
        res = await dealsAPI.update(dealId, {
          pipelineId: value.pipelineId,
          pipelineStageId: value.pipelineStageId
        })
      } else {
        res = await dealsAPI.update(dealId, { [field]: value })
        // Apply what GHL echoed rather than what was sent — it truncates the
        // close date to a day and may reformat the value.
        const o = res?.opportunity
        setDeal((d) => d && {
          ...d,
          ...(field === 'pipelineStageId' && o?.pipelineStageId
            ? { stageId: o.pipelineStageId }
            : {}),
          // Two different properties read the deal's name: dealTag (the
          // tab's own header/breadcrumb) and opportunityName (DealSection's
          // big heading, dealName in DealSection.jsx). Only dealTag was
          // being updated here — renaming a deal updated the breadcrumb but
          // left the DealSection heading showing the old name until a full
          // page reload re-fetched the deal from scratch.
          ...(o?.name != null ? { dealTag: o.name, opportunityName: o.name } : {}),
          // Same bug as the name above: DealSection.jsx's Value field reads
          // deal.monetaryValue (the raw number) and deal.value (the
          // server-pre-formatted "£1,250" string) — this used to write
          // neither, only a monetaryValueRaw key nothing reads, so an edited
          // value kept showing the old figure until a full reload. formatMoney
          // mirrors the server's own Intl call (see money.js) so the two never
          // disagree.
          ...(o?.monetaryValue != null
            ? { monetaryValue: o.monetaryValue, value: formatMoney(o.monetaryValue, d?.currency) }
            : {}),
          ...(o?.forecastExpectedCloseDate !== undefined
            ? { forecastCloseDate: o.forecastExpectedCloseDate }
            : {}),
          // OwnerRow's collapsed view reads deal.owner (a NAME); the picker
          // itself reads deal.assignedTo (a USER ID). GHL's echoed opportunity
          // only carries assignedTo — it has no resolved name to give back —
          // so this used to update neither, leaving the old owner's name on
          // screen until a reload. `users` (loaded for the picker) is the one
          // place a name for that id is already available client-side.
          ...(field === 'assignedTo'
            ? {
                assignedTo: o?.assignedTo ?? value,
                owner: users?.find((u) => u.id === (o?.assignedTo ?? value))?.name ?? d.owner
              }
            : {})
        })
      }
      // Stage moves change the stepper, which is driven by a SEPARATE fetch
      // (dealsAPI.stages, not dealsAPI.get) — reloading only `deal` left the
      // stepper/current-stage picker showing the old stage forever, since
      // nothing ever re-ran dealsAPI.stages after the first page load.
      //
      // Delayed, not immediate — same race the customField branch above
      // already avoids: our PUT goes to GHL, GHL fires a webhook, the
      // handler fetches the opportunity back and only THEN writes our row.
      // A GET issued microseconds after the PUT resolves returns the OLD
      // stage/status and would silently revert the optimistic UI that was
      // already correct.
      if (field === 'pipelineStageId' || field === 'status' || field === 'pipeline') {
        window.setTimeout(() => {
          Promise.all([dealsAPI.get(dealId), dealsAPI.stages(dealId)])
            .then(([d, s]) => {
              setDeal(d)
              setStages(s.stages || [])
            })
            .catch(() => {})
        }, 2500)
      }
      setSavedField(field)
      window.setTimeout(() => setSavedField((f) => (f === field ? null : f)), 2200)
    } catch (err) {
      // The write FAILED, so no reconcile was scheduled and nothing else will
      // clear the custom-field spinner that `finally` now leaves running.
      // Cleared here, before the rollback, so a failed save shows its error
      // against a settled chip rather than one still pretending to work.
      setSavingField(null)
      setDeal(before)
      // Only pipelineStageId ever repaints `stages` optimistically (above) —
      // restoring it unconditionally on every other field's failure would be
      // a same-value no-op, so this is safe to run for all of them.
      setStages(beforeStages)
      setSaveError(err.message || 'Could not save that — try again')
      window.setTimeout(() => setSaveError(null), 5000)
    } finally {
      // A CUSTOM FIELD IS NOT DONE WHEN ITS REQUEST IS.
      //
      // The PUT resolves in ~700ms, but the value is not settled until the
      // 2.5s reconcile lands — our write goes to GHL, GHL webhooks us, and
      // the handler fetches the opportunity back before our row updates.
      // Clearing the spinner here let the chip look finished for ~1.8s and
      // then change again, which reads as the save undoing itself.
      //
      // So the custom-field branch owns its own spinner and clears it when
      // the reconcile returns. Every other field is synchronous from the
      // rep's point of view and clears here as before.
      if (field !== 'customField') setSavingField(null)
    }
  }

  // AI citations reference the GHL message_id; the timeline's jump anchors are
  // keyed on the row primary key (see routes/deals.js — `id` vs `messageId`).
  // Translate, then scroll + highlight.
  const [highlightedId, setHighlightedId] = useState(null)
  // Per-message selection — what the agent is allowed to read.
  //
  // Ticks are recorded locally and flushed in one batch, not sent per click:
  // five boxes meant five round trips, and the server state only actually
  // matters at the moment a question is asked.
  const pendingInclusions = useRef(new Map())

  const toggleIncluded = (m) => {
    const next = m.included === false
    setMessages((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, included: next } : x))
    )
    // Keyed "type:id" — a note and a message can carry the same id, and keying
    // on id alone would let one overwrite the other's pending decision.
    pendingInclusions.current.set(
      `${m.subjectType || 'message'}:${m.subjectId || m.messageId}`,
      next
    )
  }

  // Select or deselect every readable message at once. Same batching as a
  // single tick, so turning 200 messages off is one request.
  //
  // The WHOLE deal, not just the loaded pages: older rows are fetched first,
  // so "untick all" cannot leave unloaded history ticked for Co-Pilot. If that
  // fetch fails it falls back to what is loaded rather than doing nothing.
  const setAllIncluded = async (next) => {
    const extra = timelineMore.current.hasMore ? await loadAllOlder().catch(() => []) : []
    setMessages((prev) => {
      const have = new Set((prev || []).map((m) => m.id))
      return [...(prev || []), ...extra.filter((m) => !have.has(m.id))].map((x) => {
        // Events have no content to read, so they aren't selectable. Notes and
        // tasks ARE — they were skipped here, so select-all silently left them
        // alone while appearing to cover everything.
        if (x.event) return x
        if (x.included === next) return x
        pendingInclusions.current.set(
          `${x.subjectType || 'message'}:${x.subjectId || x.messageId}`,
          next
        )
        return { ...x, included: next }
      })
    })
  }

  // Returns a promise so a caller can await it before asking — otherwise the
  // context builder reads the old state.
  const flushInclusions = async () => {
    const pending = pendingInclusions.current
    if (pending.size === 0) return
    const changes = [...pending].map(([key, included]) => {
      const [subjectType, ...rest] = key.split(':')
      return { subjectType, subjectId: rest.join(':'), included }
    })
    // Clear before the request: a failure rolls back below, and holding them
    // would double-send on the next flush.
    pending.clear()
    try {
      await aiAPI.setInclusions(dealId, changes)
    } catch {
      // Roll the checkboxes back. A box that silently didn't save is worse than
      // one that visibly bounces — the rep would believe they'd excluded
      // something they hadn't.
      setMessages((prev) =>
        prev.map((x) => {
          const type = x.subjectType || 'message'
          const id = x.subjectId || x.messageId
          const c = changes.find((y) => y.subjectType === type && y.subjectId === id)
          return c ? { ...x, included: !c.included } : x
        })
      )
    }
  }

  // Leaving the deal (switch or unmount) shouldn't lose the ticks.
  useEffect(() => {
    return () => { flushInclusions() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId])

  const filtered = useMemo(() => {
    if (!messages) return []
    return messages.filter((m) => {
      if (channelFilter.length > 0) {
        // Match on the same bucket dealChannels counted, or selecting a chip
        // would show nothing. Any selected bucket matching is enough — the
        // chips are additive (OR), so Note + Task shows both kinds rather than
        // the empty intersection of the two.
        const key = m.event ? 'ACTIVITY' : channelKeyOf(m)
        if (!channelFilter.includes(key)) return false
      }
      // Inclusion applies to real messages only — events have no checkbox,
      // so filtering them by it would silently hide the deal's history.
      if (peopleFilter.length > 0) {
        const senderMatch = m.senderId && peopleFilter.includes(m.senderId)
        const recipientMatch = (m.toIds || []).some((cid) => peopleFilter.includes(cid))
        if (!senderMatch && !recipientMatch) return false
      }
      return true
    })
  }, [messages, channelFilter, peopleFilter])

  // Accepts EITHER id.
  //
  // A timeline row carries two: `id` (our primary key, which the DOM anchor
  // `tl-${id}` is built from) and `messageId` (GHL's id). Callers pass
  // whichever they hold, and matching on only one made the rest fail
  // silently — the lookup missed, the function returned, and the button
  // looked broken:
  //
  //   MediaSection  → m.id        (was missed)
  //   AskDeal cites → c.messageId (matched)
  //   AskDeal search→ m.id        (was missed)
  //
  // Both are checked rather than making every caller agree, because a
  // mismatch here has no symptom to debug — nothing throws and nothing logs.
  // A message was filed against a different deal (or unlinked).
  //
  // Removed from THIS timeline immediately rather than refetched: the move
  // already succeeded server-side, and a refetch would redraw the whole list
  // and lose the reader's scroll position for a change they just made.
  const handleMessageMoved = (moved) => {
    setMessages((prev) =>
      (prev || []).filter((m) => m.messageId !== moved.messageId)
    )
    // No toast: this tab has no toast surface, and the row vanishing from the
    // timeline is itself the confirmation. Adding one just for this would mean
    // a notification system for a single message.
  }

  // A note was edited in the Notes rail. The timeline holds its own copy of
  // that note (fetched with the deal), so patch it here too — otherwise the
  // rail showed the new text while the timeline kept the old until a reload.
  //
  // An UNTITLED note arrives with the server's derived heading (splitNoteBody
  // lifts the body's first line into `title`). Keeping that heading beside the
  // edited full body would print the first line twice, so an untitled save
  // drops the heading and shows the whole body; the next load re-derives it.
  const handleNoteSaved = (noteId, patch) => {
    setMessages((prev) =>
      (prev || []).map((m) => {
        if (m.subjectType !== 'note' || m.subjectId !== noteId) return m
        return {
          ...m,
          title: patch.title || null,
          body: patch.body ?? m.body,
          color: patch.color ?? m.color,
          pinned: patch.pinned ?? m.pinned
        }
      })
    )
  }

  // Next page of open deals, for the switcher's scroll.
  //
  // Appends rather than replaces, and guards against a double-fire: the
  // scroll handler can trigger twice before the first response lands, which
  // would duplicate a page.
  const loadMoreDeals = async () => {
    if (!dealsCursor || loadingMoreDeals) return
    setLoadingMoreDeals(true)
    try {
      // Same status as the first page — a different one here would page a
      // different result set and interleave two queries.
      const res = await dealsAPI.list({ status: 'all', limit: 100, cursor: dealsCursor })
      setDeals((prev) => [...(prev || []), ...(res.deals || [])])
      setDealsCursor(res.hasMore ? res.nextCursor : null)
      if (res.totalCount != null) setDealsTotal(res.totalCount)
      if (res.openCount != null) setDealsOpen(res.openCount)
    } catch {
      // Stop paging rather than retry on every scroll tick — a failing
      // cursor would otherwise fire a request per wheel event.
      setDealsCursor(null)
    } finally {
      setLoadingMoreDeals(false)
    }
  }

  const jumpToMessage = (anyMessageId) => {
    if (!anyMessageId || !messages) return
    const row = messages.find(
      (m) => m.id === anyMessageId || m.messageId === anyMessageId
    )
    if (!row) {
      // The message exists but is filtered out of the current view, or it is
      // not on this deal. Silence here is what made this look broken, so say
      // so — the caller can decide whether to clear filters.
      // eslint-disable-next-line no-console
      console.warn('[timeline] no row for message', anyMessageId)
      return
    }
    setHighlightedId(row.id)

    // The timeline renders `filtered`, not every message — so a row excluded
    // by an active channel or people filter HAS no anchor in the DOM, and
    // scrolling to it is impossible however correct the lookup was. Clearing
    // the filters is what the rep wants: they asked to see this message.
    const visible = filtered.some((m) => m.id === row.id)
    if (!visible) {
      setChannelFilter([])
      setPeopleFilter([])
    }

    // Two frames, not one. The dialog unmounts in this same click and, when
    // the filters were just cleared, the timeline re-renders with more rows —
    // scrolling before either commits lands in the wrong place or finds
    // nothing at all.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = document.getElementById(`tl-${row.id}`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    })
    // Clear the highlight so a later jump to the same message re-triggers it.
    window.setTimeout(() => setHighlightedId((cur) => (cur === row.id ? null : cur)), 2600)
  }


  // Channels that ACTUALLY appear on this deal. Derived from the fetched
  // messages so a Rear-Elevation-with-only-emails doesn't show a WhatsApp
  // chip. Event rows (ACTIVITY/TASK/SYSTEM) don't count — the filter chips
  // are for real conversation channels.
  //
  // Always returns a Map (never an array) so downstream `.has()` / `.get()`
  // calls work before messages have loaded.
  // Counts every conversation message per channel, ticked or not — this chip
  // filters the timeline VIEW, so it must promise the number of rows it will
  // show. The Ask panel counts differently on purpose (only what the AI can
  // read), which is why its chips are labelled "Ask about" rather than
  // repeating these numbers.
  const dealChannels = useMemo(() => {
    const counts = new Map()
    if (!messages) return counts
    for (const m of messages) {
      // System rows (opportunity created, stage changed, DND enabled…) come
      // through with channel ACTIVITY or SYSTEM. Bucket them together under
      // one key: a rep filtering for "what happened to this deal" doesn't
      // distinguish the two, and separate chips would fragment a short list.
      const key = m.event ? 'ACTIVITY' : channelKeyOf(m)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return counts
  }, [messages])


  // `key` defaults to the label, but callers must pass an explicit one when
  // labels can repeat — two unnamed contacts both render as "Contact", and a
  // duplicate React key would collapse them into one element.
  const chip = (label, active, onClick, extra, key) => (
    <button
      key={key ?? label}
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        cursor: 'pointer',
        height: 30, padding: '0 14px',
        border: active ? '2px solid var(--brand-primary)' : '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-pill)',
        background: active ? 'var(--brand-primary)' : '#fff',
        color: active ? '#fff' : 'var(--text-body)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-md)', fontWeight: active ? 500 : 400,
        transition: 'all 0.15s ease-out'
      }}
    >
      {extra}
      {label}
    </button>
  )

  // Empty state — no open deals in this location
  if (deals && deals.length === 0) {
    return (
      <div
        style={{
          padding: 40, maxWidth: 640, margin: '40px auto',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-md)',
          background: '#fff', textAlign: 'center'
        }}
      >
        <span
          className="ms"
          style={{ fontSize: 'var(--text-2xl)', color: 'var(--text-faint)', marginBottom: 8, display: 'block' }}
        >
          sell
        </span>
        <h2 style={{ fontSize: 'var(--text-xl)', marginBottom: 6 }}>No open deals in this location</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-md)' }}>
          Once a deal is created in your CRM, it'll appear here automatically.
        </p>
      </div>
    )
  }

  if (dealsError) {
    return (
      <div
        style={{
          padding: 16, margin: 20,
          border: '1px solid var(--status-stuck)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--tint-rose)',
          color: 'var(--status-stuck)', fontSize: 'var(--text-md)'
        }}
      >
        Failed to load deals: {dealsError}
      </div>
    )
  }

  // First load: no switcher or header to frame yet, so the skeleton stands
  // in for the whole tab.
  if (!deals) return <DealHubSkeleton />


  // A contact field edited IN PLACE on the Customer band or a People card
  // (see ContactFieldEdit). Both read deal.people, so patching the person
  // there repaints every copy at once — no refetch, which would race GHL's
  // ContactUpdate webhook and could paint the old value back.
  const patchContact = (contactId, patch) => {
    setDeal((d) => d && {
      ...d,
      people: (d.people || []).map((p) => (p.id === contactId ? { ...p, ...patch } : p))
    })
  }

  // A business linked to one of the deal's contacts — from the deal card's
  // "+ Add business" or a People card's Business pencil.
  const linkBusiness = (business) => {
    setDeal((d) => {
      if (!d) return d
      const have = new Set((d.businesses || []).map((b) => b.id))
      if (have.has(business.id)) return d
      return {
        ...d,
        businesses: [...(d.businesses || []), {
          id: business.id,
          name: business.name || 'Unnamed business',
          city: business.city || null
        }]
      }
    })
    // MERGED, NOT REPLACED — the same protection the
    // custom-field reconcile carries, which this handler was
    // written without.
    //
    // 2.5s is a guess at a round trip we do not control: our
    // PATCH to GHL, GHL's RelationCreate webhook back to us,
    // then our own write of contacts.business_id. When the guess
    // loses, the refetch returns a deal with NO business on it
    // and `setDeal(fresh)` wholesale threw the painted one away
    // — the business appeared and then removed itself, which is
    // exactly what was reported after the relation writer had
    // already fixed the server side.
    //
    // So the business just linked is pinned over the refetch.
    // Everything else still comes from the server, which is the
    // point of reconciling. A later refetch — a reload, a tab
    // switch — carries no pin and shows the settled truth.
    const pinnedBusiness = {
      id: business.id,
      name: business.name || 'Unnamed business',
      city: business.city || null
    }
    window.setTimeout(() => {
      dealsAPI.get(dealId).then((fresh) => {
        if (!fresh) return
        setDeal((cur) => {
          if (!cur) return fresh
          const list = fresh.businesses || []
          if (list.some((b) => b.id === pinnedBusiness.id)) return fresh
          return { ...fresh, businesses: [...list, pinnedBusiness] }
        })
      }).catch(() => {})
    }, 2500)

  }

  return (
    <div>
      {/* The OPPORTUNITY row that sat here is gone. Its switcher IS the
          toolbar's SEARCH control now — keeping both would be two ways to do
          one thing, one of them outside the card it changes, and the empty
          bordered box left behind read as a panel that failed to load. */}

      {/* Left-rail tabs (Deal / People / Media). Media comes next. */}
      {deal && !loading && (
        <div
          style={{
            padding: 'var(--space-4) 20px 0',
            maxWidth: 'none', margin: 0, boxSizing: 'border-box'
          }}
        >
          {/* ONE card around the header, the toolbar and whichever rail is
              showing — which is what the design draws. The toolbar cannot
              live inside DealSection: that only renders for leftRail 'deal',
              so switching to People unmounted the control you switch with. */}
          <section
            style={{
              border: '1px solid var(--border-default)',
              boxShadow: 'var(--shadow-card)',
              borderRadius: 'var(--radius-md)',
              background: '#fff',
              overflow: 'hidden'
            }}
          >
      <PanelHead
        icon="grid_view"
        title="Deal hub"
        accent="pine"
        subtitle={deal.dealTag || undefined}
        action={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            {deal.status && deal.status !== 'open' && (
              <StatusPill status={deal.status} />
            )}
            {/* The way to everything the card cannot edit inline — pipeline,
                status, followers, and the primary contact's own fields. Opens
                THIS DEAL'S OWN RECORD PAGE. It used to expand the deal's row
                inside the Deals list instead, which landed the rep on the list
                with a row open somewhere in it; the request names one deal, so
                the destination is that deal. */}
            {onEditDealRecord && (
              <PanelHeadButton
                icon="edit_note"
                onClick={() => onEditDealRecord(dealId)}
                title="Open the full editor for this deal"
              >
                Edit record
              </PanelHeadButton>
            )}
          </span>
        }
      />
          {/* ABOVE the three rails, not inside the Deal card.
              It lived in DealSection, which only renders for leftRail
              'deal' — so switching to People or Media unmounted the very
              control you switch with, and there was no way back without a
              reload. The toolbar belongs to whatever is showing, so it sits
              with the container that chooses. */}
          {/* The SEARCH slot holds the DEAL SWITCHER, not a plain input.
              A text box would have been a second search beside the picker,
              and the picker already searches every deal in the location —
              this is the one control, in the place the design puts it. */}
          <CardToolbar view={leftRail} onView={setLeftRail}>
          {/* Deal switcher */}
          {/* Fluid, not a fixed 420px: it fills the toolbar's SEARCH slot
              now, and a hard width overflowed that slot on a narrow card. */}
          <div ref={switcherRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
            <button
              onClick={() => setSwitcherOpen((o) => !o)}
              title={deal ? deal.dealTag : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
                cursor: 'pointer',
                height: 34, padding: '0 var(--space-3)',
                width: '100%',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                background: '#fff',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-lg)',
                color: 'var(--text-heading)', fontWeight: 600
              }}
            >
              <span className="ms" style={{ fontSize: 16, color: 'var(--accent-pine)', flex: 'none' }}>sell</span>
              <Truncate style={{ flex: 1,
                  textAlign: 'left' }}>
                {deal ? deal.dealTag : 'Select a deal…'}
              </Truncate>
              <span className="ms" style={{ fontSize: 18, color: 'var(--text-faint)', flex: 'none' }}>
                expand_more
              </span>
            </button>

            {switcherOpen && (() => {
              // Server results while searching, the cached page otherwise.
              const q = switcherQ.trim()
              const visible = q ? (switcherHits || []) : deals
              return (
              <div
                style={{
                  position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 50,
                  maxHeight: 460,
                  border: '1px solid var(--border-strong)',
                  borderRadius: 'var(--radius-md)',
                  background: '#fff', boxShadow: 'var(--shadow-overlay)',
                  display: 'flex', flexDirection: 'column'
                }}
              >
                {/* Search — sticky at the top of the dropdown */}
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                    padding: '10px var(--space-3)',
                    borderBottom: '1px solid var(--border-default)'
                  }}
                >
                  <span className="ms" style={{ fontSize: 17, color: 'var(--text-muted)' }}>search</span>
                  <input
                    autoFocus
                    // Borderless inside a bordered row, and autoFocused — the
                    // global :focus-visible ring would draw a stray box round
                    // the search text as soon as the dropdown opens.
                    className="pp-focus-inherit"
                    value={switcherQ}
                    onChange={(e) => setSwitcherQ(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setSwitcherOpen(false)}
                    placeholder="Search deals, contacts, business…"
                    style={{
                      flex: 1, minWidth: 0,
                      border: 'none', outline: 'none', background: 'transparent',
                      fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                      color: 'var(--text-body)'
                    }}
                  />
                  {switcherQ && (
                    <button
                      onClick={() => setSwitcherQ('')}
                      title="Clear"
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22,
                        border: 'none', borderRadius: 'var(--radius-sm)',
                        background: 'var(--gray-50)', cursor: 'pointer',
                        color: 'var(--text-muted)'
                      }}
                    >
                      <span className="ms" style={{ fontSize: 14 }}>close</span>
                    </button>
                  )}
                </div>

                <div
                  style={{ overflowY: 'auto', padding: 6 }}
                  // Load the next page near the bottom, not AT it: waiting
                  // for the exact end means the rep hits a dead stop and
                  // then waits. 120px is roughly two rows of lead time.
                  //
                  // Only while not searching — a search is server-side and
                  // returns its own complete result set, so paging the open
                  // list underneath it would mix two different queries.
                  onScroll={(e) => {
                    if (q) return
                    const el = e.currentTarget
                    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
                      loadMoreDeals()
                    }
                  }}
                >
                <div
                  style={{
                    padding: '6px var(--space-2)',
                    fontSize: 'var(--text-sm)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
                    textTransform: 'uppercase', color: 'var(--text-muted)'
                  }}
                >
                  {/* "0 of 100 match" was the tell: it described the CACHED
                      page, not the location. A rep with 356 deals read it as
                      "none of your deals match" when it meant "none of the
                      hundred I happen to be holding". The search is
                      server-side now, so the count is a real result count. */}
                  {q
                    ? (switcherBusy
                        ? 'Searching…'
                        : `${visible.length} ${visible.length === 1 ? 'deal' : 'deals'} found`)
                    // "Deals (12) · Open (4)".
                    //
                    // Two numbers because the list now spans every status:
                    // the total says how much is here, the open count says
                    // how much is live. While paging it also says how far
                    // through we are — "(100 of 340)" — since a page is not
                    // the total and conflating them made a paged list look
                    // complete.
                    : (() => {
                        const total = dealsTotal ?? visible.length
                        const shown = dealsTotal != null && dealsTotal > visible.length
                          ? `${visible.length} of ${total}`
                          : `${total}`
                        return dealsOpen != null
                          ? `Deals (${shown}) · Open (${dealsOpen})`
                          : `Deals (${shown})`
                      })()}
                </div>
                {visible.length === 0 && q && !switcherBusy && (
                  <div style={{ padding: '10px var(--space-2)', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                    No deals match "{switcherQ}" — searched every deal in this
                    location, open or closed.
                  </div>
                )}
                {visible.map((d) => {
                  const active = d.id === dealId
                  return (
                    <button
                      key={d.id}
                      title={d.dealTag}
                      onClick={() => {
                        onSwitchDeal(d.id)
                        setSwitcherOpen(false)
                      }}
                      // A TINT AND A RAIL, not a solid fill.
                      //
                      // The selected row was `background: brand-primary` with
                      // `color: #fff` — but the three inner spans each set
                      // their own colour (--text-heading, --text-body,
                      // --text-muted), so the row-level white never applied.
                      // Dark text sat on dark green: the stage line measured
                      // 1.20:1, effectively invisible, and the value 1.20:1.
                      //
                      // Fixing the white would mean overriding three nested
                      // colours on one state. A tint keeps every text colour
                      // working as designed and still reads as selected — the
                      // left rail carries that, which is the convention the
                      // rest of this app already uses.
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr auto',
                        gap: 'var(--space-2)', alignItems: 'center', width: '100%',
                        cursor: 'pointer',
                        padding: 'var(--space-2) 10px',
                        // The rail replaces 3px of the left padding, so a
                        // selected row's text stays on the same vertical line
                        // as every other row's.
                        paddingLeft: active ? 7 : 10,
                        textAlign: 'left',
                        // `border: none` first, then the left edge — order
                        // matters, the shorthand would otherwise clear it.
                        border: 'none',
                        borderLeft: active ? '3px solid var(--brand-primary)' : 'none',
                        borderRadius: 'var(--radius-sm)',
                        background: active ? 'var(--tint-pine)' : '#fff',
                        color: 'var(--text-body)',
                        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                        fontWeight: active ? 600 : 400,
                        marginBottom: 2
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        {/* THE DEAL'S OWN NAME, first and unmuted. GHL names
                            an opportunity after its contact by default, so
                            many read as a person — but the ones that do not
                            ("jsmillie", "Website Lead Form") are exactly the
                            ones a rep is hunting for, and they were shown
                            with no way to tell them apart. */}
                        <div
                          style={{
                            fontWeight: 600, color: 'var(--text-heading)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                          }}
                        >
                          {d.dealTag || 'Untitled deal'}
                        </div>
                        {/* WHO IT IS FOR. The search matches on the contact's
                            email and phone as well as the deal name, so a
                            result could appear for a reason nothing on the
                            row explained — "why is this here?" with no
                            answer. */}
                        {contactLine(d) && (
                          <div
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4,
                              fontSize: 'var(--text-sm)', color: 'var(--text-body)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                            }}
                          >
                            <span className="ms" style={{ fontSize: 13, color: 'var(--text-faint)' }}>
                              person
                            </span>
                            {contactLine(d)}
                          </div>
                        )}
                        <div
                          style={{
                            fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                          }}
                        >
                          {[d.stage, d.owner].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      {d.value && (
                        <span
                          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}
                        >
                          {d.value}
                        </span>
                      )}
                    </button>
                  )
                })}
                {/* Feedback for the scroll. Without it a slow page looks
                    like the list simply ended. */}
                {!q && (loadingMoreDeals || dealsCursor) && (
                  <div style={{
                    padding: '8px var(--space-2)', textAlign: 'center',
                    fontSize: 'var(--text-sm)', color: 'var(--text-faint)'
                  }}>
                    {loadingMoreDeals ? 'Loading more…' : 'Scroll for more'}
                  </div>
                )}
                </div>
              </div>
              )
            })()}
          </div>
          </CardToolbar>

          {leftRail === 'people' && (
            <PeopleSection
              people={deal.people || []}
              peopleFilter={peopleFilter}
              onPeopleFilterChange={setPeopleFilter}
              onOpenContact={onOpenContact}
              dealId={dealId}
              onContactSaved={patchContact}
              onBusinessLinked={linkBusiness}
              // Delayed refetch, not an optimistic insert. The link is made in
              // GHL and our opportunity_contacts row is written by the
              // RelationCreate webhook, so an immediate GET returns the old
              // list — the same race that made the deal chips read "Not set"
              // after a successful save.
              onPeopleChanged={() => {
                window.setTimeout(() => {
                  dealsAPI.get(dealId).then(setDeal).catch(() => {})
                }, 2500)
              }}
            />
          )}

          {leftRail === 'deal' && (
            <DealSection
              deal={deal}
              stages={stages || []}
              onOpenContact={onOpenContact}
              // The toolbar moved INSIDE the card — see CardToolbar. The pills
              // choose what this card shows, so they belong to it.
              view={leftRail}
              onView={setLeftRail}
              // The chevrons moved from the sticky header to the card's foot,
              // where the design puts them — they describe THIS deal, and in
              // the header they sat above a card that might be showing People
              // or Media instead.
              onMoveStage={(id) => saveDealField('pipelineStageId', id)}
              search={switcherQ}
              // The card's box and the opportunity picker are ONE search.
              //
              // Its placeholder is "Search deals, contacts or businesses" —
              // a lookup across records, which is exactly what the switcher
              // does. Giving the card its own state meant a second box that
              // searched nothing.
              //
              // So it opens the switcher as you type: the results have to
              // land somewhere, and the dropdown is already built to show
              // them. Clearing it closes the dropdown again rather than
              // leaving an empty panel hanging over the card.
              onSearch={(v) => {
                setSwitcherQ(v)
                setSwitcherOpen(v.trim().length > 0)
              }}
              siblingDeals={siblingDeals}
              onOpenDeal={onSwitchDeal}
              onOpenBusiness={onOpenBusiness}
              // A business linked through one of the deal's contacts.
              //
              // Painted optimistically, then reconciled 2.5s later — the same
              // shape as the custom-field and people saves, and for the same
              // reason: the write goes to GHL, our contacts.business_id row
              // only updates when the ContactUpdate webhook lands, and an
              // immediate GET returns the OLD deal with no business on it.
              // Without the paint the chip stayed on "None linked" for the
              // whole round trip, which reads as the link having failed.
              //
              // De-duped by id: two contacts at the same company would
              // otherwise list it twice until the refetch.
              onBusinessLinked={linkBusiness}
              onContactSaved={patchContact}
              // These existed on DealSection but were never passed, so every
              // edit to value, stage or close date was discarded on reload —
              // the card accepted input and silently threw it away.
              onSaveField={saveDealField}
              saving={savingField}
              saved={savedField}
              saveError={saveError}
              fieldOptions={fieldOptions}
              users={users}
              onNeedUsers={loadUsers}
              lostReasons={lostReasons}
              onNeedLostReasons={loadLostReasons}
              // Opens this deal's full editor on the Deals tab — every field
              // the card cannot edit inline (pipeline, status, followers).
              onEditRecord={onEditDealRecord ? () => onEditDealRecord(dealId) : undefined}
            />
          )}

          {leftRail === 'media' && (
            <MediaSection
              messages={messages || []}
              // Notes and tasks attach to a contact, so "Save as note" and
              // "Create task" need the deal's people.
              people={deal?.people || []}
              onJumpToMessage={jumpToMessage}
            />
          )}
          </section>
        </div>
      )}

      {/* Filter bar — everything that narrows the timeline, plus the section
          index for the panels below it.

          Two rows on the left:
            1. People  — who sent/received
            2. Sources — inclusion (what the AI reads) + channel + add-a-source

          The section tabs sit right, wrapping under themselves rather than
          pushing the filters around. They aren't filters: they choose which
          discovery panel renders below, so they stay visually separate. */}
      {deal && !loading && (
        <div
          style={{
            padding: 'var(--space-4) 20px 0',
            maxWidth: 'none', margin: 0, boxSizing: 'border-box'
          }}
        >
          {/* Same grid as the Timeline / Commitments row below (2fr · 1fr,
              gap 14) so the section tabs start exactly on the Commitments
              panel's left edge. A flex row with its own basis values can't
              line up with a grid — the columns have to be declared the same
              way to share an edge. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)',
              gap: 14,
              alignItems: 'start'
            }}
          >
            {/* Left: the filter stack, in the Timeline column. */}
            <div
              style={{
                display: 'flex', flexDirection: 'column',
                gap: 'var(--space-2)', minWidth: 0
              }}
            >
              {deal.people?.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: 'var(--text-sm)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
                      textTransform: 'uppercase', color: 'var(--text-muted)'
                    }}
                  >
                    People
                  </span>
                  {chip(
                    'Everyone',
                    peopleFilter.length === 0,
                    () => setPeopleFilter([]),
                    <span
                      style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: 'transparent'
                      }}
                    />
                  )}
                  {deal.people.map((p) => {
                    const active = peopleFilter.includes(p.id)
                    return chip(
                      // Two unnamed contacts both rendering as "Contact" is
                      // unusable as a filter — fall back through the same
                      // identifier chain PeopleSection uses.
                      chipNameFor(p),
                      active,
                      () =>
                        setPeopleFilter((prev) =>
                          active ? prev.filter((x) => x !== p.id) : [...prev, p.id]
                        ),
                      <span
                        style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: `var(--accent-${p.accent})`
                        }}
                      />,
                      p.id
                    )
                  })}
                </div>
              )}

              {/* Sources row: inclusion + channel + add-a-source. All three
                  answer "which messages am I looking at", so they share a
                  line. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {(() => {
                  let allCount = 0
                  for (const n of dealChannels.values()) allCount += n
                  return chip(
                    `All${allCount ? ` · ${allCount}` : ''}`,
                    // Active only when nothing is picked. All isn't a bucket
                    // you add to a selection — it's the way to clear one.
                    channelFilter.length === 0,
                    () => setChannelFilter([]),
                    null,
                    'all'
                  )
                })()}
                {chipsFor(dealChannels).filter(([, ch]) => dealChannels.has(ch)).map(
                  ([label, ch]) => {
                    const n = dealChannels.get(ch) || 0
                    const on = channelFilter.includes(ch)
                    return chip(
                      `${label} · ${n}`,
                      on,
                      // Additive: each chip toggles only itself, so Note and
                      // Task can both be on. Deselecting the last one falls
                      // back to All rather than showing an empty timeline.
                      () =>
                        setChannelFilter((prev) =>
                          prev.includes(ch)
                            ? prev.filter((x) => x !== ch)
                            : [...prev, ch]
                        ),
                      // A tick on the selected ones. With several chips lit at
                      // once, "which of these am I filtering by" has to read at
                      // a glance rather than from the border weight alone.
                      on
                        ? <span className="ms" style={{ fontSize: 15, marginLeft: -3 }}>check</span>
                        : null,
                      ch
                    )
                  }
                )}
                {/* Clearing several chips one at a time is four clicks; All is
                    one, but it doesn't read as "clear" when the thing you want
                    is to stop filtering. */}
                {channelFilter.length > 0 && (
                  <button
                    onClick={() => setChannelFilter([])}
                    title="Clear the channel filter"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      height: 30, padding: '0 12px',
                      border: 'none', borderRadius: 'var(--radius-pill)',
                      background: 'transparent', color: 'var(--text-link)',
                      fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                      cursor: 'pointer'
                    }}
                  >
                    <span className="ms" style={{ fontSize: 15 }}>close</span>
                    Clear {channelFilter.length}
                  </button>
                )}
                <button
                  title="Attach a message or document the sync missed — coming next"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    height: 30, padding: '0 14px',
                    border: '1px dashed var(--border-strong)',
                    borderRadius: 'var(--radius-pill)',
                    background: '#fff', color: 'var(--text-body)',
                    fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                    cursor: 'pointer'
                  }}
                >
                  <span className="ms" style={{ fontSize: 16 }}>add</span>
                  Add a source
                </button>
              </div>
            </div>

            {/* Empty right column. The section tabs used to live here; the
                panels are all stacked in the rail now, so nothing selects
                between them. The column stays so the filter stack keeps the
                same width as the Timeline below it. */}
            <div style={{ minWidth: 0 }} />
          </div>
        </div>
      )}

      {/* Switching deals swaps every panel below the header at once. Render
          the body's shape while it loads rather than leaving the previous
          deal on screen — otherwise you can't tell whether you're looking at
          the deal you just picked or the one before it. */}
      {loading && <DealBodySkeleton />}

      {/* Timeline */}
      <div
        style={{
          padding: loading ? 0 : 'var(--space-4) 20px 28px',
          maxWidth: 'none', margin: 0, boxSizing: 'border-box'
        }}
      >
        {error && (
          <div
            style={{
              padding: 16,
              border: '1px solid var(--status-stuck)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--tint-rose)',
              color: 'var(--status-stuck)',
              fontSize: 'var(--text-md)'
            }}
          >
            {error}
          </div>
        )}
        {!loading && !error && messages && (
          <>
            {/* TIMELINE ACROSS THE FULL ROW, then Tasks and Notes side by
                side in equal halves below it (client request, Oct 2026).
                The timeline was two-thirds of the width with the two rails
                stacked in a 320px column beside it — message bodies wrapped
                early, and the rails were tall and thin. */}
            <div style={{ display: 'grid', gap: 14, marginBottom: 14, minWidth: 0 }}>
              <Timeline
                messages={filtered}
                dealId={dealId}
                // Reply on an email opens a composer INSIDE that thread's card,
                // as GHL's reply does — not the Co-Pilot, and not the one at
                // the foot of the timeline. To is whoever the email was with:
                // the sender of an inbound one, the recipient of one we sent.
                // m.messageId is the GHL id the server's reply lookup keys on;
                // m.id is only the timeline row's own id, and serves as the
                // nonce — stable while the box is open, so a re-render does
                // not reset what the rep is typing.
                replyComposer={(m, close) => (
                  <MessageComposer
                    inline
                    onClose={close}
                    dealId={dealId}
                    people={deal?.people || []}
                    primaryContactId={deal?.primaryContactId || null}
                    replyTarget={{
                      messageId: m.messageId || m.id,
                      subject: m.subject || '',
                      contactId: m.direction === 'inbound' ? m.senderId : (m.toIds || [])[0] || null,
                      nonce: m.id
                    }}
                    onSent={refreshAfterSend}
                  />
                )}
                // The composer for a NEW message, at the foot of the timeline.
                footer={
                  <MessageComposer
                    dealId={dealId}
                    people={deal?.people || []}
                    primaryContactId={deal?.primaryContactId || null}
                    onSent={refreshAfterSend}
                    lastChannel={lastChannel}
                  />
                }
                // Every deal on this contact, including won/lost — a manager
                // may deliberately file a message against a closed deal.
                dealTargets={siblingDeals}
                onMessageMoved={handleMessageMoved}
                highlightedId={highlightedId}
                onToggleSelect={toggleIncluded}
                onSelectAll={setAllIncluded}
                // Infinite scroll: older pages load as the rep nears the top.
                hasMore={olderState.hasMore}
                loadingMore={olderState.loading}
                onLoadMore={loadOlder}
                // So the empty state can tell "this deal has no history" from
                // "your chips hide all of it" — only this component knows the
                // unfiltered count and which chips are on.
                totalCount={messages?.length ?? null}
                filtersActive={channelFilter.length > 0 || peopleFilter.length > 0}
                onClearFilters={() => { setChannelFilter([]); setPeopleFilter([]) }}
              />
              {/* Both panels shown, no tab to pick between them — a rep reading
                  a deal wants the tasks AND the notes. Two equal columns; on a
                  narrow screen (each under 340px) they stack instead. */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
                gap: 14, alignItems: 'start', minWidth: 0
              }}>
                {/* people: a task is stored against a contact, so creating
                    one from the rail needs someone to attach it to. */}
                <DealTasksSection
                  dealId={dealId}
                  people={deal?.people || []}
                  // "All tasks →" jumps to the Tasks tab. Was a dead button.
                  onOpenAll={onOpenTab ? () => onOpenTab('tasks') : undefined}
                />
                <DealNotesSection
                  dealId={dealId}
                  people={deal?.people || []}
                  onOpenAll={onOpenTab ? () => onOpenTab('notes') : undefined}
                  onNoteSaved={handleNoteSaved}
                />
              </div>
            </div>
            {/* FULL WIDTH, below the timeline/rail grid — not inside the
                narrow right column under Notes, where it used to sit.
                Ten qualification headings are long free-text answers, and in a
                320px rail each one wrapped to four or five lines; across the
                page they read as a row per heading. It is also what the design
                shows: its own band between the rail and Co-Pilot. */}
            <QualificationSection
              qualification={deal?.qualification || []}
              // The same saver the deal card's custom-field pickers use, so a
              // qualification answer is written exactly like any other
              // opportunity custom field — one write path, one set of error
              // handling.
              onSave={saveDealField}
              savingField={savingField}
            />

            {/* Co-Pilot in a panel of its own, so it carries the same solid
                header band as every other section rather than starting as a
                bare grid of sidebar + transcript. */}
            <section
              style={{
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-card)',
                borderRadius: 'var(--radius-md)',
                background: '#fff',
                overflow: 'hidden',
                // Matches Qualification's own 14 above it, so the stacked
                // full-width bands are evenly spaced.
                marginTop: 14
              }}
            >
            <PanelHead
              icon="auto_awesome"
              // "Co-Pilot", per the client design (Oct 2026). The working
              // name in planning talk is still "Deal AI"; the Control panel
              // labels it that way too, pending a decision there.
              title="Co-Pilot"
              subtitle="Ask about this deal"
              accent="plum"
            />
            <AskDeal
              dealId={dealId}
              seedQuestion={askSeed}
              onActionConfirmed={onActionConfirmed}
              onJumpToMessage={jumpToMessage}
              // Pending ticks must land before the question does, or the server
              // builds context from the old selection.
              beforeAsk={flushInclusions}
              // The live timeline rows. AskDeal derives its channel counts
              // from these so a checkbox tick updates them instantly —
              // re-fetching from the server would lag behind unflushed ticks.
              messages={messages || []}
              // The deal's contacts. "Save as note" and "Create task" store
              // against a CONTACT, so AskDeal disables both when this is
              // empty — and it was never passed, so it defaulted to [] and
              // the two buttons were permanently disabled on every deal,
              // contacts or not. The tooltip said "this deal has no
              // contacts" on deals that plainly had one.
              people={deal?.people || []}
            />
            </section>
          </>
        )}
      </div>
    </div>
  )
}

// Short label for a people filter chip. Prefers a first name (chips are
// narrow), then any other identifier we hold, so two unnamed contacts stay
// tellable apart. Mirrors PeopleSection's displayFor() fallback chain.
function chipNameFor(p) {
  const first = (p.firstName || '').trim()
  if (first) return first
  const last = (p.lastName || '').trim()
  if (last) return last
  if (p.email) return p.email.split('@')[0]
  if (p.phone) return p.phone
  if (p.business) return p.business
  return 'Contact'
}

// The contact a deal is for, as one line.
//
// Falls through every identifier we hold, because the switcher's search
// matches on all of them: a result found by email must be able to SHOW that
// email, or the row appears for a reason the reader cannot see.
//
// Returns null when the line would only repeat the deal's own name — GHL
// default-names an opportunity after its contact, so printing both would show
// the same string twice on most rows.
function contactLine(d) {
  const c = d.contact || {}
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
  const label = name || c.business || c.email || c.phone || null
  if (!label) return null
  if (label.trim().toLowerCase() === String(d.dealTag || '').trim().toLowerCase()) return null
  // A named contact still shows its email, since that is often what was
  // typed. Business and phone stand alone — they are the fallback already.
  if (name && c.email) return `${name} · ${c.email}`
  return label
}
