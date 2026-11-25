import apiClient from './client'

const enc = encodeURIComponent

export const appointmentsAPI = {
  // The board, in one request: the appointments, the people to draw columns
  // for, and the timezone to draw them in.
  //
  // Not three calls. The columns have to agree with the rows — a board whose
  // people arrived from a different request than its appointments can show
  // work in a column that is not there — and the timezone has to be settled
  // before anything is positioned at all.
  //
  //   from, to      ISO. The window; the server clamps it to a month.
  //   kind          'appointment' | 'blocked' | 'all'  (default all)
  //   assignedTo    one person, or 'unassigned'
  //   dealId        this deal's appointments
  list: (params = {}) => apiClient.get('/api/appointments', { params }),

  // The calendars a booking can be made on. Fetched live from the CRM — we
  // hold no calendars table — so this is worth caching in the caller rather
  // than asking on every modal open.
  calendars: () => apiClient.get('/api/appointments/calendars'),

  // The times a calendar will accept on one day — so the booking card can
  // say before Save whether the chosen time is open. { slots: [iso, …] }.
  //   calendarId, from, to (ISO, end exclusive), timezone, userId?
  freeSlots: (params) => apiClient.get('/api/appointments/free-slots', { params }),

  // Book one. Needs a calendar AND a customer: GHL has no concept of an
  // appointment with nobody, and time held with no customer is blocked time,
  // which is a different object entirely.
  //
  // The new appointment is NOT in our database when this resolves — the
  // AppointmentCreate webhook writes it a moment later. What comes back is
  // GHL's created appointment, so the caller can say what it booked while it
  // waits for the row to land.
  //
  // notifyCustomer is off unless passed true. Booking is the one case where
  // notifying is arguably right — the customer has just agreed to a visit —
  // so it is the first place to consider turning it on.
  create: (body) => apiClient.post('/api/appointments', body),

  // Move, reassign or cancel. Writes go to GoHighLevel, not to our database:
  // the AppointmentUpdate webhook writes our row, so what comes back here is
  // GHL's echo and the board settles the card onto it.
  //
  // Send ONLY what changed — the server passes the patch straight through,
  // and restating unchanged fields is how a stale copy in this browser
  // overwrites somebody else's edit.
  //
  // notifyCustomer is OFF unless explicitly passed true. The server owns
  // that default and documents why; it is named here so a caller cannot send
  // one by accident.
  update: (id, patch) => apiClient.patch(`/api/appointments/${enc(id)}`, patch),

  // Prefer update(id, { appointmentStatus: 'cancelled' }) — a cancelled
  // appointment keeps its slot in the diary and its link to the deal, which
  // is the record that somebody was going to visit and then did not. This is
  // for the genuine mistake, where the booking should never have existed.
  remove: (id, { notifyCustomer } = {}) =>
    apiClient.delete(`/api/appointments/${enc(id)}`, { data: { notifyCustomer } }),

  // Link the appointment to one of its customer's deals, by hand. Stored in
  // Deal Hub — GHL has no appointment-to-deal field — and the sync leaves a
  // hand-made choice alone (migration 145).
  //   { dealId }        link this deal
  //   { dealId: null }  deliberately none
  //   { mode: 'auto' }  give it back to the automatic link
  setDeal: (id, body) => apiClient.put(`/api/appointments/${enc(id)}/deal`, body),

  // Custom object records on the appointment's CUSTOMER — GHL's associations
  // cannot point at an appointment, so the customer is the link.
  //   → { objects: [{ key, singular, plural }], records: [...] }
  records: (id) => apiClient.get(`/api/appointments/${enc(id)}/records`),
  searchRecords: (objectKey, q) =>
    apiClient.get('/api/appointments/records/search', { params: { objectKey, ...(q ? { q } : {}) } }),
  linkRecord: (id, objectKey, recordId) =>
    apiClient.post(`/api/appointments/${enc(id)}/records`, { objectKey, recordId }),
  unlinkRecord: (id, relationId) =>
    apiClient.delete(`/api/appointments/${enc(id)}/records/${enc(relationId)}`)
}
