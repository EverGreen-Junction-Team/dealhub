import { setTabState } from '../../hooks/useTabState'
import { ALL } from './ListFilters'

// "View" on a task or a note in another tab's list (Contacts, Deals): open
// the Tasks or Notes tab NARROWED to that record's contact or deal, with the
// item itself opened on arrival — rather than the contact record or the Deal
// hub, which made the rep find it again.
//
// The tab's remembered state is seeded before switching, so it mounts already
// filtered. Every other filter is reset to the widest: the item may belong to
// someone else, be due any time, or not match a search left over from before.
//
// `scope` is { contactId } or { dealId } — the Tasks and Notes tabs' own
// filter shape (WorkFilters).

export function viewNoteInTab(openTab, scope, noteId) {
  setTabState('notes', 'filters', scope)
  setTabState('notes', 'author', ALL)
  setTabState('notes', 'q', '')
  setTabState('notes', 'focus', noteId || null)
  openTab('notes')
}

export function viewTaskInTab(openTab, scope, taskId) {
  setTabState('tasks', 'filters', scope)
  setTabState('tasks', 'owner', ALL)
  setTabState('tasks', 'status', 'open')
  setTabState('tasks', 'dueFilter', 'all')
  setTabState('tasks', 'dueRange', null)
  setTabState('tasks', 'q', '')
  setTabState('tasks', 'focus', taskId || null)
  openTab('tasks')
}
