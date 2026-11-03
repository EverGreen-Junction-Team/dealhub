import { useEffect, useState } from 'react'
import { dealsAPI } from '../api/deals'
import { businessesAPI } from '../api/businesses'

// The deals and companies a note or task can be linked to.
//
// Used by the standalone Notes and Tasks pages, where there is no deal in
// scope, so the rep has to pick one. The Deal Hub's rails do NOT use this —
// they already know their deal and pass defaultOpportunityId instead, which
// hides the picker rather than offering a one-option dropdown.
//
// LAZY. `enabled` is false until an editor actually opens, so a rep who only
// reads the list never pays for two extra requests. Once fetched the result is
// kept for the life of the component: these lists change on the order of days,
// and refetching per editor open would be a request every time.
//
// A FAILED FETCH IS NOT AN ERROR HERE. Both lists degrade to empty, and the
// editors hide a picker whose list is empty — so a note can still be written
// without a link. Reporting "could not load deals" on a note dialog would be
// noise about a field the rep may not have wanted.
export function useLinkTargets(enabled) {
  const [targets, setTargets] = useState(null)

  useEffect(() => {
    if (!enabled || targets !== null) return
    let alive = true
    Promise.all([
      // status: 'all' — a note can legitimately be filed against a won or lost
      // deal, and the default list route returns open ones only.
      // 25, not 200. These are only a SEED — the pickers search the server for
      // anything not in this list (see searchDeals below), so preloading 200
      // rows to filter client-side was both a heavy request and a false
      // promise: it silently capped what could be found.
      dealsAPI.list({ status: 'all', limit: 25 }).catch(() => null),
      businessesAPI.list({ limit: 25 }).catch(() => null)
    ]).then(([d, b]) => {
      if (!alive) return
      // `deals` and `businesses` are the actual response keys — checked
      // against the route handlers, not guessed. An `|| items` fallback here
      // would silently mask a renamed key as "no deals found".
      setTargets({
        deals: d?.deals || [],
        businesses: b?.businesses || []
      })
    })
    return () => { alive = false }
  }, [enabled, targets])

  return targets || { deals: [], businesses: [] }
}

// Search functions for RemotePicker, shaped to { value, label }.
//
// Live here beside useLinkTargets so the seed list and the search that extends
// it agree on how a deal and a business are labelled — the note editor and the
// task editor both use these, and a label that differed between the two would
// look like two different records.
//
// `status: 'all'`: a note or task can legitimately be filed against a won or
// lost deal, and the list route defaults to open only.
//
// 20 rows, not 200: this is a search result the rep is about to pick from, not
// a list to browse. A longer page would just be more to scroll past.
const SEARCH_PAGE = 20

// `contactId` SCOPES THE SEARCH TO THAT CONTACT'S DEALS.
//
// A note or task belongs to a contact, so the deal it is filed against should
// be one of that contact's. Without this the picker searched every deal in the
// location and a rep could file a note against a deal the contact has nothing
// to do with — invisibly, because the search runs on the server and the list
// never said what it was showing.
//
// Server-side it matches the contact card's own chips: the deals where they
// are PRIMARY, plus the ones they are merely linked to through
// opportunity_contacts (an architect on someone else's deal).
//
// Omitting it keeps the old location-wide behaviour, which is what the deals
// list itself wants.
export function searchDeals(q, { contactId } = {}) {
  // `q` is OMITTED when empty rather than sent as q='' — the picker now
  // fetches a first page before anything is typed, and an empty param is a
  // filter the server has to reason about rather than a request for the
  // unfiltered list.
  return dealsAPI.list({ status: 'all', ...(q ? { q } : {}), limit: SEARCH_PAGE, contactId })
    .then((r) => (r?.deals || []).map(dealOption))
}

export function searchBusinesses(q) {
  // Empty `q` omitted — see searchDeals.
  return businessesAPI.list({ ...(q ? { q } : {}), limit: SEARCH_PAGE })
    .then((r) => (r?.businesses || []).map(businessOption))
}

// One place that decides what a deal is called in a picker. `dealTag` is the
// opportunity name; the fallbacks cover a deal with no name, which GHL allows.
export function dealOption(d) {
  return { value: d.id, label: d.dealTag || d.opportunityName || d.name || d.id }
}

export function businessOption(b) {
  return { value: b.id, label: b.name || b.id }
}
