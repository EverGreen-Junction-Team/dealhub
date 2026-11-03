# Pending functionality

Controls from the October 2026 designs that are on screen but don't fully work yet. Each needs a backend change (or a product decision) before it can do what the design implies. Revisit at the end of the UI pass, then wire each one up or remove it.

## Shown, but not doing what the design implies

| Tab | Control | What it does now | What's missing |
|---|---|---|---|
| Contacts (list) | **No deals** pill chevron | Nothing (inert) | Decorative; there's nothing to list. Could open a "link a deal" flow if one is wanted. |
| Businesses | **Type** and **Owner** filters, **Type** field, **Tags** "+ Tag" | Shown disabled | Businesses have no type, owner or tag field in GHL or in our `businesses` table. Needs a decision on where each comes from (e.g. a GHL custom field), then a column and a filter. |
| Businesses | **Open tasks** / **Tasks** / **Notes** counts on cards and list rows | "—" on cards; "No tasks" / "No notes" chips in the list | The businesses list sends no task or note counts. The business page's Tasks panel lists them (loaded through its contacts). |
| Businesses | **Open pipeline** figure | Value of every deal, closed ones included | The list sends `totalValue`; an open-only value needs `openPipelineValue` from the server. |

## Now working (verified Oct 2026 — kept so the history is visible)

| Tab | Control | How it works |
|---|---|---|
| Contacts | **Add contact** button | Create form → `POST /api/contacts`. |
| Contacts (grid + list) | **Selection checkboxes** (per card, per row, header select-all) | Selecting shows the bulk bar: **Add tag**, **Assign owner**, **Delete**, **Clear**. Bulk Change type and Export were removed (Oct 2026, client request). |
| Contacts | Bulk **Assign owner** | `PATCH /api/contacts/:id` with `assignedTo`, once per contact — `contactPatch` allows it. |
| Contacts | Bulk **Delete** | `DELETE /api/contacts/:id`, once per contact, after a confirm dialog. Cannot be undone — GHL has no restore. |
| Contacts (grid) | **Type** row pencil | Edits Lead / Customer; saved with the card as `contactType`, which `contactPatch` maps to GHL's `type`. |
| Contact record | **Contact type** dropdown | Sent with Save as `contactType` (mapped to GHL's `type`). |
| Contact record | **Timezone** cell | Sent with Save; `contactPatch` maps `timezone`. |
| Contacts (grid) | **Show on cards → Tasks / Notes** | The contacts list sends each contact's first five open tasks and notes; the card lists them, with "+N more". |
| Contacts (list) | **Tasks** pill chevron (`4 tasks ˅`) | A menu of the contact's open tasks (first five, from the list route). |
| Contacts (list) | **Notes** pill chevron (`1 note ˅`) | A menu of the contact's notes (first five). |
| Notes | **Search** box | `GET /api/notes?q=` — matches the note body. |
| Notes (grid + rows) | **View BUSINESS** row | `GET /api/notes` returns `business: { id, name }`. |

## Blocked by the platform

| Tab | Control | Status |
|---|---|---|
| Tasks | Linking a task to a deal | Switched off (`TASK_DEAL_EDITING = false` in `TasksTab.jsx`). GHL refuses `POST /associations/relations` over OAuth ("Relations cannot be modified via OAuth channel"). Reading a task's deals still works. |
