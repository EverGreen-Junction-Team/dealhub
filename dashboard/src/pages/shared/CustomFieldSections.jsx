import React, { useMemo, useRef, useState } from 'react'
import { Select, Input, DatePicker } from 'antd'
import dayjs from 'dayjs'

// Custom fields, grouped into the folders GHL puts them in.
//
// SHARED between contacts and opportunities. Both objects have folders, both
// render as sections, and the only difference is the wire spelling on save
// (field_value for contacts, fieldValue for opportunities) — which is the
// caller's business, not this component's.
//
// WHY FOLDERS. GHL's own panel renders one collapsible section per
// folder — "General Info", "Website Form", "Charlie lead upload (Crittall)" —
// and a rep navigates by them. Our editor showed no custom fields at all: the
// definitions were synced (migration 023) but never sent to the client, and
// the folder each belongs to was not stored until migration 064.
//
// COLLAPSED BY DEFAULT. A location with eight folders and forty fields would
// otherwise bury the contact's name, email and phone under a wall of inputs.
//
// Whether the FIRST section opens is the caller's call (openFirst). Contacts
// open it so the panel does not read as empty; deals do not, because one
// folder there holds 22 fields and opening it pushes People, Tasks and Notes
// off the screen.
//
// WHAT IS EDITABLE. Everything except FILE_UPLOAD, which the server flags
// `readOnly` because there is no OAuth documents API — a control that could
// never save would be a lie. Those render their stored value with a note.

// GHL's dataType values, mapped to how each is edited. Unknown types fall
// through to a text box: a field we do not recognise is still better shown
// than hidden, and text round-trips through GHL unchanged.
const MULTI = new Set(['CHECKBOX', 'MULTIPLE_OPTIONS'])
const SINGLE = new Set(['SINGLE_OPTIONS', 'DROPDOWN', 'RADIO'])

export default function CustomFieldSections({
  groups = [],
  // Uploads one or more files to a FILE_UPLOAD field:
  //   (fieldKey, FileList) => Promise<[{ name, url }]>
  //
  // Optional. Without it those fields render read-only, which is what they
  // were before GHL's upload endpoint turned out to exist.
  onUpload,
  // { [fieldId]: value } — only what has been edited, so a save sends the
  // changed fields rather than rewriting all forty.
  draft = {},
  onChange,
  disabled = false,
  // Open the first section, or start with every one closed.
  //
  // Contacts keep the first open: a contact has a handful of custom fields
  // and the panel would otherwise read as empty. A DEAL on this account has
  // 22 in one folder, which pushes People, Tasks and Notes — the things a rep
  // came to the deal for — a full screen down. There the right default is
  // closed, with the field count on the header saying what is inside.
  openFirst = true
}) {
  // Held as a Set of ids rather than a per-section boolean so "expand all"
  // stays a one-liner later.
  const [open, setOpen] = useState(() =>
    new Set(openFirst && groups.length ? [groups[0].id ?? '__ungrouped__'] : []))

  if (!groups.length) return null

  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {groups.map((g) => {
        const key = g.id ?? '__ungrouped__'
        const isOpen = open.has(key)
        // How many fields in this folder actually have a value — shown on the
        // collapsed header so a rep can tell which sections hold data without
        // opening each one.
        const filled = g.fields.filter((f) => {
          const v = draft[f.id] !== undefined ? draft[f.id] : f.value
          return v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
        }).length

        return (
          <section key={key} className="pp-cf-group">
            <button
              type="button"
              className="pp-cf-head"
              onClick={() => toggle(key)}
              aria-expanded={isOpen}
            >
              <span className="ms pp-cf-chev">
                {isOpen ? 'expand_more' : 'chevron_right'}
              </span>
              <span className="pp-cf-name">{g.name}</span>
              {/* Says what is inside, so a collapsed section is not opaque. */}
              <span className="pp-cf-count">
                {filled > 0 ? `${filled} of ${g.fields.length}` : `${g.fields.length}`}
              </span>
            </button>

            {isOpen && (
              <div className="pp-cf-body">
                {g.fields.map((f) => (
                  <CustomField
                    key={f.id}
                    field={f}
                    value={draft[f.id] !== undefined ? draft[f.id] : f.value}
                    dirty={draft[f.id] !== undefined}
                    onChange={(v) => onChange(f.id, v)}
                    onUpload={onUpload}
                    disabled={disabled}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function CustomField({ field, value, dirty, onChange, onUpload, disabled }) {
  const type = String(field.type || 'TEXT').toUpperCase()
  const options = useMemo(
    () => (field.options || []).map((o) => ({ value: o, label: o })),
    [field.options]
  )

  // Marks a field whose value differs from what is saved, matching the rest
  // of the form — it is how a rep knows what pressing Save will send.
  const dirtyStyle = dirty
    ? { borderColor: 'var(--brand-primary)', background: 'var(--tint-pine)' }
    : undefined

  let control
  if (field.upload) {
    // FILE_UPLOAD. These were read-only on the belief that GHL has no upload
    // API for them; it does —
    //   POST /locations/:id/customFields/upload
    // — so this is a real picker. When no handler is passed it falls back to
    // showing the stored value, which is the old behaviour.
    control = (
      <FileField
        field={field}
        value={value}
        onUpload={onUpload}
        onChange={onChange}
        disabled={disabled}
      />
    )
  } else if (field.readOnly) {
    // Nothing sets this today. Kept so a field type that genuinely cannot be
    // written has somewhere to say so, rather than silently rendering an
    // input that fails on save.
    control = (
      <div className="pp-cf-readonly">
        {value
          ? <span className="pp-cf-file">{String(value)}</span>
          : <span className="pp-cf-empty">Not set</span>}
        <span className="pp-cf-note">Edit this in your CRM</span>
      </div>
    )
  } else if (MULTI.has(type)) {
    control = (
      <Select
        mode="multiple"
        value={Array.isArray(value) ? value : value ? [value] : []}
        onChange={onChange}
        options={options}
        disabled={disabled}
        placeholder="None selected"
        style={{ width: '100%' }}
        popupClassName="pp-menu"
        allowClear
      />
    )
  } else if (SINGLE.has(type)) {
    control = (
      <Select
        value={value || undefined}
        onChange={(v) => onChange(v ?? '')}
        options={options}
        disabled={disabled}
        placeholder="Not set"
        style={{ width: '100%' }}
        popupClassName="pp-menu"
        allowClear
        showSearch
        // Server-side options are already the full list; antd's own filter is
        // right here because there is no request behind it.
        optionFilterProp="label"
      />
    )
  } else if (type === 'DATE') {
    control = (
      <DatePicker
        value={value ? dayjs(value) : null}
        onChange={(d) => onChange(d ? d.format('YYYY-MM-DD') : '')}
        disabled={disabled}
        style={{ width: '100%' }}
        format="D MMM YYYY"
        placeholder="Not set"
      />
    )
  } else if (type === 'TEXTBOX_LIST' || type === 'LARGE_TEXT' || type === 'TEXTAREA') {
    control = (
      <Input.TextArea
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={field.placeholder || 'Not set'}
        autoSize={{ minRows: 2, maxRows: 6 }}
        style={dirtyStyle}
      />
    )
  } else {
    // TEXT, NUMERICAL, PHONE, MONETARY and anything unrecognised.
    control = (
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={field.placeholder || 'Not set'}
        inputMode={type === 'NUMERICAL' || type === 'MONETARY' ? 'decimal' : undefined}
        style={dirtyStyle}
      />
    )
  }

  return (
    <label className="pp-cf-field">
      <span className="pp-cf-label">{field.label}</span>
      {control}
    </label>
  )
}

// A FILE_UPLOAD custom field.
//
// UPLOADS IMMEDIATELY, unlike every other field here, which batches into the
// panel's Save. A file is not a draft value: it goes to GHL's own storage and
// comes back as a URL, and there is nothing meaningful to hold locally in the
// meantime. Batching would also mean a rejected text field discards an upload
// that already succeeded.
//
// The stored value is whatever GHL put there — usually a URL, sometimes a
// comma-joined list of them. Rendered as links rather than raw text: a rep
// wants to open the file, and a 200-character signed URL as body text is
// unreadable.
function FileField({ field, value, onUpload, onChange, disabled }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  // GHL stores these as a URL or a comma-joined list of them.
  const existing = useMemo(() => {
    if (!value) return []
    const raw = Array.isArray(value) ? value : String(value).split(',')
    return raw
      .map((v) => String(v).trim())
      .filter(Boolean)
      .map((url) => ({
        url,
        // The last path segment, minus any signature. A signed URL's query
        // is 100+ characters and is not a filename.
        name: decodeURIComponent(url.split('?')[0].split('/').pop() || 'file')
      }))
  }, [value])

  const pick = async (e) => {
    const files = [...(e.target.files || [])]
    // Reset the input straight away, so choosing the SAME file twice still
    // fires a change event.
    e.target.value = ''
    if (files.length === 0 || !onUpload) return

    setBusy(true)
    setError(null)
    try {
      const uploaded = await onUpload(field.key || field.id, files)
      // The server returns [{ name, url }]. Append rather than replace: a
      // multi-file field accumulates, and replacing would silently drop
      // whatever was already attached.
      const urls = [...existing.map((f) => f.url), ...uploaded.map((f) => f.url)]
      onChange(urls.join(','))
    } catch (err) {
      setError(err.message || 'That file could not be uploaded')
    } finally {
      setBusy(false)
    }
  }

  const max = field.maxFiles || null
  const full = max ? existing.length >= max : false

  return (
    <div className="pp-cf-files">
      {existing.length > 0 && (
        <div className="pp-cf-filelist">
          {existing.map((f, i) => (
            <a
              key={`${f.url}-${i}`}
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pp-cf-filechip"
              title={f.name}
            >
              <span className="ms" style={{ fontSize: 14 }}>attach_file</span>
              <span className="pp-cf-filename">{f.name}</span>
            </a>
          ))}
        </div>
      )}

      {onUpload ? (
        <>
          <input
            ref={inputRef}
            type="file"
            multiple={!max || max > 1}
            onChange={pick}
            disabled={disabled || busy || full}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || busy || full}
            className="pp-cf-upload"
            title={
              full ? `This field holds at most ${max} file${max === 1 ? '' : 's'}`
                : 'Choose a file to upload'
            }
          >
            <span className="ms" style={{ fontSize: 15 }}>
              {busy ? 'progress_activity' : 'upload'}
            </span>
            {busy ? 'Uploading…'
              : full ? `${max} of ${max}`
                : existing.length > 0 ? 'Add another' : 'Upload a file'}
          </button>
        </>
      ) : (
        existing.length === 0 && <span className="pp-cf-empty">No file</span>
      )}

      {error && <span className="pp-cf-error">{error}</span>}
    </div>
  )
}
