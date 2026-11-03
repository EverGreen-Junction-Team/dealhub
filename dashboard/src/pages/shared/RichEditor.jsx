import React, { useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
// Signature-only extensions. TextStyle is the carrier Color writes onto —
// Color alone does nothing without it.
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import Image from '@tiptap/extension-image'
// Both ship in @tiptap/extensions, which StarterKit already pulls in — no new
// dependency. Placeholder was MISSING: the CSS targeted p.is-editor-empty,
// a class only this extension adds, so the placeholder never rendered and the
// editor just sat blank.
import { Placeholder, CharacterCount } from '@tiptap/extensions'
import { sanitiseHtml, isHtmlEmpty } from '../../utils/sanitiseHtml'

// The note/task body editor.
//
// WHY RICH TEXT AT ALL. GoHighLevel stores a note body as HTML — the network
// payload for its own editor is
// `<p style="margin: 0px">text<strong>bold</strong></p>`. Our editor was a
// plain <textarea> that ran stripHtml() on the way in and sent plain text on
// the way out, so a note written with formatting in GHL LOST that formatting
// the moment a rep edited it here. That is data loss, not a missing feature.
//
// WHY TIPTAP RATHER THAN contentEditable. Browser-native editing
// (document.execCommand) is deprecated and its list and paste behaviour
// diverges between engines. TipTap sits on ProseMirror, which holds an explicit
// document model and applies changes as transactions — so a paste from Word or
// Gmail resolves to a predictable tree instead of whatever the browser felt
// like inserting.
//
// PASTE IS SANITISED ON THE WAY IN, not only on save. Two reasons: what the rep
// sees in the editor should be what gets stored, and ProseMirror's own schema
// filtering is about document validity, not safety.
export default function RichEditor({
  value = '',
  onChange,
  placeholder = 'Write a note…',
  disabled = false,
  // Rendered under the editor. GHL's own limit is 65000; the caller passes its
  // own so this component does not encode a server rule.
  maxLength = null,
  minHeight = 150,
  invalid = false,
  autoFocus = false,
  // RICH MODE — off everywhere except the signature editor.
  //
  // A note does not need brand colour or a logo, and every control added to a
  // toolbar is one more thing a rep has to read past to find Bold. A
  // signature is the one place where colour and an image ARE the content:
  // the thing being built is a small piece of branded layout, not prose.
  rich = false,
  // Extra toolbar buttons from the caller (the composer's paperclip). Styled
  // by the caller with the toolbar's own pp-tb-btn class.
  toolbarExtra = null,
  // And at the far right, after Undo/Redo (the composer's Discard and Send).
  toolbarEnd = null
}) {
  // Character count, mirrored into React state — see onUpdate below.
  const [count, setCount] = useState(0)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Off deliberately, each for a reason:
        //   heading    — a note is not a document; H1 inside a timeline row
        //                fights the row's own heading
        //   codeBlock  — nothing in this workflow pastes code, and it swallows
        //                Enter
        //   horizontalRule — no use in a note, and it is easy to insert by
        //                accident with '---'
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        // Link is configured separately below, so the StarterKit copy would
        // register a duplicate extension and warn.
        link: false
      }),
      Underline,
      Placeholder.configure({ placeholder }),
      // ProseMirror's own count, which counts the DOCUMENT's text — the same
      // thing the server measures. My previous approach re-parsed getHTML()
      // through htmlToText on every keystroke, which is both slower and a
      // second implementation of "how long is this".
      // limit STOPS typing at the cap rather than letting a rep write past it
      // and discover the problem at save time. textSize counts textContent,
      // which is what the server measures — counting the HTML would refuse
      // notes the server would accept.
      ...(maxLength
        ? [CharacterCount.configure({ limit: maxLength, mode: 'textSize' })]
        : []),
      ...(rich ? [
        TextStyle,
        Color,
        Image.configure({
          inline: false,
          // No base64. A pasted screenshot becomes a data: URI that inflates
          // every email by ~133% of the file size and is stripped by some
          // clients anyway — an image must be hosted somewhere and referenced
          // by https, which is also the only scheme the sanitiser keeps.
          allowBase64: false
        })
      ] : []),
      Link.configure({
        openOnClick: false,          // clicking inside an editor should place the cursor
        autolink: true,              // typing a URL makes it a link
        defaultProtocol: 'https',
        // ProseMirror's own href guard. Belt and braces with sanitiseHtml:
        // this stops a javascript: link being CREATED, the sanitiser stops one
        // being stored or rendered.
        protocols: ['http', 'https', 'mailto', 'tel']
      })
    ],
    // Sanitised on the way IN as well. `value` may be a note written in GHL
    // (or by an integration) and we are about to hand it to a contentEditable.
    content: sanitiseHtml(value),
    editable: !disabled,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: {
        class: 'pp-editor-content',
        // Announced to screen readers as a rich text field.
        role: 'textbox',
        'aria-multiline': 'true'
      },
      // THE PASTE HOOK. Without this, pasting from Word or a web page inserts
      // its markup — including `<script>`-adjacent constructs and pages of
      // inline styles — and ProseMirror keeps whatever its schema permits.
      transformPastedHTML: (html) => sanitiseHtml(html)
    },
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML()
      // ProseMirror emits '<p></p>' for an empty document. Reporting that as
      // content would make a required-field check pass on an empty note.
      onChange?.(isHtmlEmpty(html) ? '' : html)
      // Local state so THIS component re-renders.
      //
      // The counter reads editor.storage.characterCount, and ProseMirror
      // storage is not React state — mutating it triggers nothing. Relying on
      // the parent's onChange did not help either: the value it sends back is
      // the one we just emitted, so the sync effect no-ops and no render
      // happens. Verified in a browser: the counter never appeared.
      if (maxLength) {
        setCount(ed.storage.characterCount?.characters() ?? 0)
      }
    }
  })

  // Keep the editor in step when the caller replaces `value` wholesale — a
  // different note opened in the same dialog, or a save echoing GHL's version
  // back.
  //
  // Guarded against the feedback loop: onUpdate → caller setState → new
  // `value` → setContent → onUpdate. Comparing to the editor's current HTML
  // means a value we ourselves just emitted is a no-op.
  useEffect(() => {
    if (!editor) return
    const incoming = sanitiseHtml(value)
    if (incoming === editor.getHTML()) return
    if (isHtmlEmpty(incoming) && isHtmlEmpty(editor.getHTML())) return
    // `false` — do not emit an update for a programmatic change, or opening a
    // note would immediately mark the form dirty.
    editor.commands.setContent(incoming, false)
  }, [value, editor])

  useEffect(() => {
    if (editor) editor.setEditable(!disabled)
  }, [disabled, editor])

  // Seed the count once the editor exists, and again whenever content is set
  // programmatically (opening a note that already has a body). onUpdate does
  // not fire for setContent with emitUpdate:false, so without this an existing
  // note showed no counter until the first keystroke.
  useEffect(() => {
    if (!editor || !maxLength) return
    setCount(editor.storage.characterCount?.characters() ?? 0)
  }, [editor, maxLength, value])

  if (!editor) return null

  // With `limit` set, typing cannot exceed the cap, so this is only reachable
  // when pre-existing content (a note written in GHL) is already over.
  const over = maxLength ? count > maxLength : false

  // One element, not a wrapper around it. The outer div existed only to stack
  // the character counter beneath the box; the counter now lives inside it.
  return (
    <div
      className="pp-editor"
      style={{
        border: `1px solid ${invalid || over ? 'var(--status-stuck)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius-md)',
        background: disabled ? 'var(--surface-sunken)' : 'var(--surface-card)',
        overflow: 'hidden'
      }}
    >
      <Toolbar editor={editor} disabled={disabled} rich={rich} extra={toolbarExtra} end={toolbarEnd} />

      {/* minHeight goes on the EDITABLE surface via a CSS variable, not on
          this wrapper.
          EditorContent renders a wrapper div and ProseMirror renders the
          contentEditable inside it. A minHeight here sized the wrapper while
          the editable child stayed as tall as its text — so the click target
          ended where the text ended, and the leftover wrapper height showed
          below it as a second empty box with a line between. That line was
          the bottom of the editable area, not a border.
          Setting it on .pp-editor-content instead means the whole box is
          editable and clicking the empty space places the cursor. */}
      <EditorContent
        editor={editor}
        style={{ ['--pp-editor-min']: `${minHeight}px` }}
      />

      {/* INSIDE the box, not floating under it.
          It was a right-aligned line below the border, which read as an
          unrelated caption — and on the task editor it collided with the
          footer's status text. As a bottom bar it belongs to the field, and
          it only appears once there is something to count: "0 / 2,000" on an
          empty note is noise. */}
      {maxLength && count > 0 && (
        <div
          style={{
            display: 'flex', justifyContent: 'flex-end',
            padding: '4px 10px 5px',
            borderTop: '1px solid var(--border-default)',
            fontSize: 'var(--text-sm)',
            fontVariantNumeric: 'tabular-nums',
            color: over
              ? 'var(--status-stuck-text)'
              : count > maxLength * 0.9 ? 'var(--text-muted)' : 'var(--text-faint)'
          }}
        >
          {/* Only shows the ceiling as it gets close — the limit is not
              interesting at 40 characters of 2,000. */}
          {count > maxLength * 0.75
            ? `${count.toLocaleString()} / ${maxLength.toLocaleString()}`
            : count.toLocaleString()}
        </div>
      )}
    </div>
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────
//
// Mirrors the controls GHL's own editor offers, minus the ones its buttons
// expose that our schema does not support (colour pickers, alignment) — a
// button that cannot round-trip through our sanitiser would be a control that
// silently loses its effect.
function Toolbar({ editor, disabled, rich = false, extra = null, end = null }) {
  const btn = (label, icon, isActive, run, title) => (
    <button
      key={label}
      type="button"
      // onMouseDown + preventDefault, NOT onClick: a click moves focus out of
      // the contentEditable first, which collapses the selection — so bolding
      // selected text would apply to nothing.
      onMouseDown={(e) => { e.preventDefault(); run() }}
      disabled={disabled}
      title={title || label}
      aria-label={title || label}
      aria-pressed={isActive}
      className={isActive ? 'pp-tb-btn pp-tb-on' : 'pp-tb-btn'}
    >
      <span className="ms" style={{ fontSize: 17 }}>{icon}</span>
    </button>
  )

  const link = () => {
    const existing = editor.getAttributes('link')?.href || ''
    // eslint-disable-next-line no-alert
    const url = window.prompt('Link URL', existing)
    if (url === null) return                       // cancelled
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    // Validated by running it through the sanitiser: if the href does not
    // survive, it was not a safe scheme. One rule for creating and storing
    // links rather than two that can disagree.
    const probe = sanitiseHtml(`<a href="${url.replace(/"/g, '&quot;')}">x</a>`)
    if (!/href=/.test(probe)) {
      window.alert('That link is not allowed. Use http, https, mailto or tel.')
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  const image = () => {
    // eslint-disable-next-line no-alert
    const url = window.prompt('Image URL (must be https)')
    if (!url) return
    // Same trick as link(): validate by asking the sanitiser. If the img does
    // not survive, the URL was not one we would ever send — one rule for
    // inserting and for storing, rather than two that can disagree.
    const probe = sanitiseHtml(`<img src="${url.replace(/"/g, '&quot;')}">`)
    if (!/<img/.test(probe)) {
      window.alert('That image URL is not allowed. It must start with https://')
      return
    }
    editor.chain().focus().setImage({ src: url }).run()
  }

  return (
    <div className="pp-toolbar">
      {btn('Bold', 'format_bold', editor.isActive('bold'),
        () => editor.chain().focus().toggleBold().run(), 'Bold (⌘B)')}
      {btn('Italic', 'format_italic', editor.isActive('italic'),
        () => editor.chain().focus().toggleItalic().run(), 'Italic (⌘I)')}
      {btn('Underline', 'format_underlined', editor.isActive('underline'),
        () => editor.chain().focus().toggleUnderline().run(), 'Underline (⌘U)')}
      {btn('Strike', 'strikethrough_s', editor.isActive('strike'),
        () => editor.chain().focus().toggleStrike().run(), 'Strikethrough')}

      <span className="pp-tb-sep" />

      {btn('Bullets', 'format_list_bulleted', editor.isActive('bulletList'),
        () => editor.chain().focus().toggleBulletList().run(), 'Bulleted list')}
      {btn('Numbers', 'format_list_numbered', editor.isActive('orderedList'),
        () => editor.chain().focus().toggleOrderedList().run(), 'Numbered list')}
      {btn('Quote', 'format_quote', editor.isActive('blockquote'),
        () => editor.chain().focus().toggleBlockquote().run(), 'Quote')}

      <span className="pp-tb-sep" />

      {btn('Link', 'link', editor.isActive('link'), link, 'Add or edit a link')}
      {rich && btn('Image', 'image', false, image, 'Insert an image by URL')}
      {rich && (
        <span className="pp-tb-colour" key="colour">
          {/* A native colour input, not a custom popover. It is one element,
              it is keyboard accessible for free, and it gives the OS picker
              a rep already knows. The swatch shows the CURRENT colour so the
              control reads as state rather than as a button. */}
          <input
            type="color"
            disabled={disabled}
            value={editor.getAttributes('textStyle')?.color || '#1a1a1a'}
            onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
            title="Text colour"
            aria-label="Text colour"
          />
        </span>
      )}
      {rich && btn('No colour', 'format_color_reset', false,
        () => editor.chain().focus().unsetColor().run(), 'Remove text colour')}
      {btn('Clear', 'format_clear', false,
        () => editor.chain().focus().unsetAllMarks().clearNodes().run(),
        'Remove formatting')}

      {/* A caller's own controls, after the formatting ones — the timeline
          composer puts its paperclip here, where GHL has it. Nothing renders
          for an editor that passes none. */}
      {extra && (
        <>
          <span className="pp-tb-sep" />
          {extra}
        </>
      )}

      <span style={{ flex: 1 }} />

      {btn('Undo', 'undo', false,
        () => editor.chain().focus().undo().run(), 'Undo (⌘Z)')}
      {btn('Redo', 'redo', false,
        () => editor.chain().focus().redo().run(), 'Redo (⇧⌘Z)')}

      {/* A caller's controls at the far right — the composer's Discard and
          Send, on the same row as the formatting, as GHL lays it out. */}
      {end}
    </div>
  )
}
