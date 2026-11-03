import React, { useState, useEffect, useRef } from 'react'
import { useClipTooltips } from '../hooks/useClipTooltips'
import DealHubTab from './tabs/DealHubTab'
import DealsTab from './tabs/DealsTab'
import CopilotTab from './tabs/CopilotTab'
import InsightsTab from './tabs/InsightsTab'
import BusinessesTab from './tabs/BusinessesTab'
import ContactsTab from './tabs/ContactsTab'
import TasksTab from './tabs/TasksTab'
import NotesTab from './tabs/NotesTab'
import ControlCentreTab from './tabs/ControlCentreTab'
import HomeTab from './tabs/HomeTab'
import { summaryAPI } from '../api/summary'
import { useAuth } from '../context/AuthContext'

// Top-nav shell for the Deal Hub app.
//
// One state atom drives the whole app:
//   activeTab   — which tab is currently rendered
//   selectedDealId — which deal the DealHub tab is showing (persists across
//                    tab switches, so users can jump to Tasks, come back and
//                    still be on the same deal)
//
// Cross-tab navigation goes through openDeal(id) → the Deals tab calls it
// when a user clicks a deal card, and it flips activeTab to 'hub'
// automatically. That's the "click a deal card → jump into deal hub" flow.

// Order: Deal hub → Businesses → Deals → Contacts → Tasks → Notes → Control.
// Businesses comes second because it's the widest lens: a business rolls up the
// deals, contacts and conversations that every tab after it shows one slice of.
const TABS = [
  // Home leads, per the client's nav. Its page is a placeholder for now —
  // see HomeTab — but the tab is real so position, history and Back all
  // treat it as a place.
  { id: 'home',       label: 'Home',         icon: 'home' },
  { id: 'hub',        label: 'Deal hub',     icon: 'space_dashboard' },
  { id: 'copilot',    label: 'Insights AI',  icon: 'auto_awesome' },
  // Next to Insights AI deliberately: one ANSWERS a question you type, the
  // other shows the 24 questions already answered for this account. Someone
  // looking for "why are we losing deals" could reasonably start at either.
  { id: 'insights',   label: 'Insights',     icon: 'insights' },
  { id: 'businesses', label: 'Businesses',   icon: 'domain' },
  { id: 'deals',      label: 'Deals',        icon: 'sell' },
  { id: 'contacts',   label: 'Contacts',     icon: 'group' },
  { id: 'tasks',      label: 'Tasks',        icon: 'task_alt' },
  { id: 'notes',      label: 'Notes',        icon: 'sticky_note_2' },
  { id: 'control',    label: 'Control panel', icon: 'tune' }
]

// One navigation position. Back has to restore ALL of it, not just the tab:
// arriving at a contact record sets both activeTab AND openContactId, so
// rewinding the tab alone would land you on the Contacts LIST rather than the
// deal you actually came from.
// What to call a position in the Back tooltip. "Back" on its own doesn't say
// where, and after two or three jumps that's the thing you actually want to
// know before clicking.
function labelForPlace(p) {
  const tab = TABS.find((t) => t.id === p.tab)
  const name = tab ? tab.label : p.tab
  if (p.contactId) return `${name} — contact record`
  if (p.businessId) return `${name} — business record`
  return name
}

function samePlace(a, b) {
  return a.tab === b.tab
    && a.dealId === b.dealId
    && a.contactId === b.contactId
    && a.businessId === b.businessId
}

// Where the rep was, across a page reload.
//
// The app is a single route inside a GHL iframe — there are no URLs, so a
// reload has nothing to restore from and every position resets to the Deal
// hub. A rep editing a contact who refreshes (or whose iframe reloads on its
// own) lands somewhere else entirely and has to navigate back.
//
// Namespaced by location: the same browser can hold several sub-accounts, and
// restoring one account's contact id into another shows a record that is not
// theirs.
//
// Unlike useTabState — which deliberately does NOT persist, because a filter
// from yesterday reappearing with no explanation is worse than a clean page —
// this is the page you were literally just on. Restoring it is what a browser
// would do if we had URLs.
const POSITION_KEY = (locationId) => `pp.position.${locationId || 'unknown'}`;

function readPosition(locationId) {
  try {
    const raw = localStorage.getItem(POSITION_KEY(locationId))
    if (!raw) return null
    const p = JSON.parse(raw)
    // Validate rather than trust: a stale or hand-edited value must not put
    // the shell into a tab that no longer exists.
    if (!p || typeof p.tab !== 'string') return null
    return p
  } catch {
    // Private browsing, cleared storage, corrupt JSON — a missing position is
    // never worth failing the app for.
    return null
  }
}

export default function DealHubShell() {
  // Tooltips on any line the CSS has clipped — the contact-card fields, email
  // subjects, thread names and attachment filenames all ellipsise through a
  // class rather than an inline style, so Truncate never saw them and they
  // had no tooltip at all. Run once here, for the whole app, rather than
  // converting every call site.
  useClipTooltips()

  const { location } = useAuth()
  // Restored once, on the first render, from where we were before a reload.
  // Lazy initialisers so localStorage is read once rather than every render.
  const restored = useRef(readPosition(location?.id)).current
  // HOME when nothing is remembered — a first visit, a new browser, an
  // incognito window. It fell back to the Deal hub, which predates Home and
  // opened a new user on an empty deal picker. A remembered tab still wins,
  // so a refresh returns to where the rep was.
  const [activeTab, setActiveTab] = useState(() => restored?.tab || 'home')
  const [selectedDealId, setSelectedDealId] = useState(() => restored?.dealId || null)
  // Location-wide totals for the top-nav pill counters. One fetch on mount.
  // Matches what each tab actually shows (Deals 343 = every open opp, etc).
  const [counts, setCounts] = useState(null)

  // The nav's live height, published as --pp-nav-h so the Timeline's sticky
  // day headers sit just under it. It wraps to two rows on a narrow frame,
  // so a fixed 60px would tuck the headers behind the second row.
  const headerRef = useRef(null)
  useEffect(() => {
    const el = headerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const publish = () => el.parentElement?.style.setProperty('--pp-nav-h', `${el.offsetHeight}px`)
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    summaryAPI.counts()
      .then((c) => alive && setCounts(c))
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const [openBusinessId, setOpenBusinessId] = useState(() => restored?.businessId || null)
  // Which deal the Deals tab should open EXPANDED for editing. Set by the Deal
  // Hub's "Edit full record" action; cleared on the next navigation so
  // returning to the tab later does not silently reopen an editor.
  const [editDealId, setEditDealId] = useState(null)
  const [openContactId, setOpenContactId] = useState(() => restored?.contactId || null)

  // Where we've been. A stack, not the browser's history: the app is one route
  // inside an iframe, so there are no URLs to go back through — every jump
  // between tabs and records is a state change the browser never sees.
  //
  // Holds only PREVIOUS positions; the current one lives in the state above.
  const [history, setHistory] = useState([])

  const here = {
    tab: activeTab,
    dealId: selectedDealId,
    contactId: openContactId,
    businessId: openBusinessId
  }

  // Remember where we are, so a reload comes back here.
  //
  // Writes on every move rather than on unload: an iframe can be torn down
  // without firing beforeunload, and this is four short strings — cheap
  // enough that there is no reason to batch it.
  useEffect(() => {
    try {
      localStorage.setItem(POSITION_KEY(location?.id), JSON.stringify(here))
    } catch {
      // Storage disabled or full. Losing the position is a small cost; an
      // exception here would take the whole shell down.
    }
    // `here` is rebuilt every render, so depend on its fields, not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedDealId, openContactId, openBusinessId, location?.id])

  // The single way to move. Records where we were, then goes.
  const navigate = (next) => {
    const to = { ...here, ...next }
    // Clicking the tab you're already on, or the same record twice, shouldn't
    // push a step you then have to click Back through.
    if (samePlace(here, to)) return
    setHistory((h) => [...h, here])
    setActiveTab(to.tab)
    setSelectedDealId(to.dealId)
    setOpenContactId(to.contactId)
    setOpenBusinessId(to.businessId)
    // One-shot: only the navigation that requested it carries editDealId.
    // Without this, going to Deals for any other reason later would reopen the
    // editor on a deal the rep had finished with.
    if (to.tab !== 'deals') setEditDealId(null)
  }

  // A tab telling us it moved internally (opened or closed a record). The tab
  // has ALREADY changed its own state, so this records the step and syncs the
  // shell's copy of the position — it must not push the tab again, which is
  // why it isn't navigate().
  const noteInternalMove = (next) => {
    const to = { ...here, ...next }
    if (samePlace(here, to)) return
    setHistory((h) => [...h, here])
    setSelectedDealId(to.dealId)
    setOpenContactId(to.contactId)
    setOpenBusinessId(to.businessId)
  }

  const goBack = () => {
    setHistory((h) => {
      if (h.length === 0) return h
      const prev = h[h.length - 1]
      setActiveTab(prev.tab)
      setSelectedDealId(prev.dealId)
      setOpenContactId(prev.contactId)
      setOpenBusinessId(prev.businessId)
      return h.slice(0, -1)
    })
  }

  // Keyboard navigation.
  //
  // The browser's own Back button is useless here: this app runs inside GHL's
  // iframe, so Back navigates the PARENT page and takes the rep out of the
  // app entirely. Our history is internal, so the shortcuts have to be too.
  //
  //   Alt+Left / Backspace   go back one position
  //   Alt+1 .. Alt+7         jump straight to a tab
  //
  // Alt rather than Cmd/Ctrl: the parent GHL app and the browser have already
  // claimed most of those, and a shortcut that fights the host is worse than
  // none. Plain Backspace is included because it is the muscle-memory key for
  // "back", but ONLY outside a text field — see the guard below, without which
  // it would swallow the delete key while a rep is typing.
  React.useEffect(() => {
    const onKey = (e) => {
      // Never hijack a key the user is typing with. contentEditable covers the
      // rich-text editors; the tag names cover inputs, textareas and selects.
      const el = e.target;
      const typing = el && (
        el.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '')
      );

      // A modal is open? Leave it alone — Escape belongs to the modal, and a
      // tab switch underneath one would strand it over the wrong page.
      if (document.querySelector('[role="dialog"], .pp-modal')) return;

      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
        return;
      }
      if (e.key === 'Backspace' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        goBack();
        return;
      }
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        const tab = TABS[Number(e.key) - 1];
        if (tab) {
          e.preventDefault();
          navigate({ tab: tab.id });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });


  // Opening a record CLEARS the other two ids. Otherwise a contact opened
  // after a business would leave the business id set, and Back — which
  // restores the whole position — would reopen a record you'd already left.
  const openDeal = (dealId) =>
    navigate({ tab: 'hub', dealId, contactId: null, businessId: null })

  // Contact chips on tasks/notes open that person's record. The Contacts tab
  // owns the detail view, so we hand it the id and switch to it.
  const openContact = (contactId) =>
    navigate({ tab: 'contacts', contactId, businessId: null })

  // Business links on the Deal card open that business's record. Same pattern
  // as contact chips: hand the id to the tab that owns the detail view and
  // switch to it.
  const openBusiness = (businessId) =>
    navigate({ tab: 'businesses', businessId, contactId: null })

  // Back, as a chip that sits SECOND in the nav — after Home, before the
  // rest — which is the order the client's design draws. It used to lead
  // the row as a control of its own; now Home is the row's first chip and
  // Back follows it, so "start again" and "go back one" sit together.
  // Disabled rather than hidden on the first screen: a control that appears
  // and disappears makes the whole header jump sideways every time you
  // navigate, and the tabs beside it move with it.
  const backButton = (
        <button
          onClick={goBack}
          disabled={history.length === 0}
          title={
            history.length === 0
              ? 'Nowhere to go back to yet'
              : `Back to ${labelForPlace(history[history.length - 1])}  (Alt+\u2190 or Backspace)`
          }
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            flex: 'none',
            height: 34, padding: '0 14px 0 11px',
            // DARK when it can act, ghost when it cannot. The design fills
            // Back in gray-800 beside the green active tab — the two
            // "where you are / where you were" controls, both solid, and
            // everything else outlined. A white Back read as one more tab.
            border: history.length === 0
              ? '1px solid var(--border-strong)'
              : '1px solid var(--gray-800)',
            borderRadius: 'var(--radius-pill)',
            background: history.length === 0 ? '#fff' : 'var(--gray-800)',
            color: history.length === 0 ? 'var(--text-faint)' : '#fff',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-md)', fontWeight: 600,
            cursor: history.length === 0 ? 'default' : 'pointer',
            opacity: history.length === 0 ? 0.55 : 1
          }}
        >
          <span className="ms" style={{ fontSize: 18 }}>arrow_back</span>
          Back
        </button>
  )

  return (
    <div data-dealhub style={{ minHeight: '100vh', background: 'var(--surface-page)' }}>
      {/* Header bar: brand + tabs + search */}
      {/* Sticky: the section tabs are how you move around the app, so they
          shouldn't scroll away on a long deal. zIndex clears the Timeline's
          sticky day headers, which would otherwise ride over this bar. */}
      <header
        ref={headerRef}
        style={{
          position: 'sticky', top: 0, zIndex: 20,
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          minHeight: 60, padding: '10px 20px',
          borderBottom: '1px solid var(--border-default)',
          background: '#fff',
          // A shadow only once it's over content, so it reads as a layer
          // rather than a permanent band.
          boxShadow: '0 1px 2px rgba(23, 33, 46, 0.06)'
        }}
      >
        {/* NO SUB-ACCOUNT NAME HERE.
            It sat to the left of Back with a vertical rule after it, and the
            pair was removed deliberately: GHL's own sidebar already names the
            sub-account directly above this header, so the row repeated what
            was on screen an inch away and spent ~290px of a wrapping header
            doing it. The divider went with it — a rule separating a heading
            from a nav has nothing to separate once the heading is gone.
            `location` itself is still used — location.id keys the saved
            position and useTabState's location check — but nothing reads the
            NAME any more, so the binding went with the markup. */}
        {/* Tab chips */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TABS.map((t) => {
            const active = activeTab === t.id
            // Location-wide count on each section chip. Deal-hub + Control
            // centre chips don't have a meaningful total, so we skip them.
            const countMap = {
              businesses: counts?.businesses,
              contacts: counts?.contacts,
              deals:    counts?.deals,
              tasks:    counts?.tasks,
              notes:    counts?.notes
            }
            const count = countMap[t.id]
            return (
              <React.Fragment key={t.id}>
              <button
                onClick={() => navigate({ tab: t.id })}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  cursor: 'pointer',
                  height: 34, padding: '0 14px',
                  border: active
                    ? '1px solid var(--brand-primary)'
                    : '1px solid var(--border-strong)',
                  borderRadius: 'var(--radius-pill)',
                  background: active ? 'var(--brand-primary)' : '#fff',
                  color: active ? '#fff' : 'var(--text-body)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--text-md)', fontWeight: active ? 600 : 400,
                  transition: 'all 0.15s ease-out'
                }}
              >
                <span className="ms" style={{ fontSize: 16 }}>{t.icon}</span>
                {t.label}
                {typeof count === 'number' && (
                  <span
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      minWidth: 20, height: 20, padding: '0 6px',
                      borderRadius: 'var(--radius-pill)',
                      // The chip itself is now solid brand when active, so a
                      // brand-filled badge with white text inside it would be
                      // invisible. Invert: white pill, brand digits.
                      background: active ? 'rgba(255,255,255,0.92)' : 'var(--gray-100)',
                      color: active ? 'var(--brand-primary)' : 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', fontWeight: 600,
                      marginLeft: 2
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
              {t.id === 'home' && backButton}
              </React.Fragment>
            )
          })}
        </div>

        {/* Global search (⌘K across all tabs) is intentionally deferred
            until each tab's scoped search proves insufficient. Every tab
            already has its own in-page search that fits its content. */}
      </header>

      {/* Tab content */}
      <main>
        {activeTab === 'home' && (
          <HomeTab counts={counts} onOpenTab={(tab) => navigate({ tab })} />
        )}
        {activeTab === 'hub' && (
          <DealHubTab
            dealId={selectedDealId}
            onSwitchDeal={(id) => navigate({ tab: 'hub', dealId: id })}
            onAutoSelectDeal={setSelectedDealId}
            onOpenBusiness={openBusiness}
            // Same for the People cards' "View contact", which was disabled
            // with a "coming next" title purely because this was not passed.
            onOpenContact={openContact}
            // Cross-tab jumps from the rails' "All tasks" / "All notes" links.
            // They were hardcoded disabled with a "coming next" title because
            // the rail had no way to reach the shell's navigate() — this is
            // that way. Back still works: navigate() pushes history.
            onOpenTab={(tab) => navigate({ tab })}
            // "Edit full record" on the deal card: open the Deals tab with
            // THIS deal's editor already expanded, rather than making the rep
            // find the row again.
            onEditDealRecord={(id) => { setEditDealId(id); navigate({ tab: 'deals' }) }}
          />
        )}
        {activeTab === 'copilot' && (
          <CopilotTab
            // Clicking a deal chip or citation opens it in the hub, which is
            // where a rep goes to check an answer.
            onOpenDeal={openDeal}
          />
        )}
        {activeTab === 'insights' && <InsightsTab />}
        {activeTab === 'deals' && (
          <DealsTab
            onOpenDeal={openDeal}
            // The table's Contact column opens that person's record, the same
            // way a contact chip does on a task or note.
            onOpenContact={openContact}
            // The grid card's View BUSINESS.
            onOpenBusiness={openBusiness}
            initialEditDealId={editDealId}
            // The List view's "View" on a task or note opens Tasks / Notes.
            onOpenTab={(tab) => navigate({ tab })}
          />
        )}
        {/* Deal links on a contact record jump into the Deal hub. */}
        {/* Deal + contact links on a business roll-up reuse the same
            cross-tab navigation as tasks and notes. */}
        {activeTab === 'businesses' && (
          <BusinessesTab
            onOpenDeal={openDeal}
            onOpenContact={openContact}
            openBusinessId={openBusinessId}
            onBusinessViewed={() => setOpenBusinessId(null)}
            onNavigate={noteInternalMove}
          />
        )}
        {activeTab === 'contacts' && (
          <ContactsTab
            onOpenDeal={openDeal}
            onOpenBusiness={openBusiness}
            openContactId={openContactId}
            onContactViewed={() => setOpenContactId(null)}
            onNavigate={noteInternalMove}
            // The contact record's Tasks / Notes "All →" links.
            onOpenTab={(tab) => navigate({ tab })}
          />
        )}
        {/* Deal chips on tasks + notes jump to that deal in the hub, which
            is the "click a task to see it on the deal hub" flow. */}
        {activeTab === 'tasks' && (
          <TasksTab
            onOpenDeal={openDeal}
            onOpenContact={openContact}
            // The task card names a business now, so it needs the route to
            // one — the same handler the Businesses roll-up already uses.
            onOpenBusiness={openBusiness}
          />
        )}
        {activeTab === 'notes' && (
          <NotesTab
            onOpenDeal={openDeal}
            onOpenContact={openContact}
            onOpenBusiness={openBusiness}
          />
        )}
        {activeTab === 'control' && <ControlCentreTab />}
      </main>
    </div>
  )
}
