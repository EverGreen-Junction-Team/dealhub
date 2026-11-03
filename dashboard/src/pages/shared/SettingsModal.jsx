import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import MemoryManageModal from './MemoryManageModal'

// The "Account" entry's settings — Personalization (the memory feature)
// and Keyboard shortcuts, matching GHL's own Ask AI settings modal. A left
// nav + right content pane, same shape as the reference screenshots.

const TABS = [
  { id: 'personalization', icon: 'palette', label: 'Personalization' },
  { id: 'shortcuts', icon: 'keyboard', label: 'Keyboard shortcuts' }
]

export default function SettingsModal({ onClose }) {
  const [tab, setTab] = useState('personalization')
  const [manageOpen, setManageOpen] = useState(false)

  return (
    <>
      {createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="pp-portal"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
        style={{
          position: 'fixed', inset: 0, zIndex: 900,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(15, 23, 42, 0.32)',
          backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
          padding: 16
        }}
      >
        <div
          style={{
            width: 'min(760px, 100%)', height: 'min(520px, 90vh)',
            background: '#fff',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-overlay)',
            display: 'grid', gridTemplateColumns: '260px 1fr',
            overflow: 'hidden'
          }}
        >
          <div style={{
            padding: 16,
            borderRight: '1px solid var(--border-default)',
            background: 'var(--gray-25)',
            display: 'grid', gap: 4, alignContent: 'start'
          }}>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, marginBottom: 8,
                border: 'none', borderRadius: 'var(--radius-sm)',
                background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer'
              }}
            >
              <span className="ms" style={{ fontSize: 20 }}>close</span>
            </button>

            {TABS.map((t) => {
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    height: 40, padding: '0 12px',
                    border: 'none', borderRadius: 'var(--radius-md)',
                    background: active ? '#fff' : 'transparent',
                    boxShadow: active ? '0 1px 2px rgba(31, 36, 48, 0.08)' : 'none',
                    color: 'var(--text-heading)',
                    fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
                    textAlign: 'left', cursor: 'pointer',
                    // The wider column above should already stop this
                    // wrapping, but pin it explicitly — a fixed-height
                    // button with wrapped two-line text looks cramped and
                    // pushes against its own edges rather than growing.
                    whiteSpace: 'nowrap'
                  }}
                >
                  <span className="ms" style={{ fontSize: 18, color: 'var(--text-muted)' }}>
                    {t.icon}
                  </span>
                  {t.label}
                </button>
              )
            })}
          </div>

          <div style={{ minWidth: 0, overflowY: 'auto', padding: '20px 24px' }}>
            {tab === 'personalization' ? (
              <PersonalizationTab onManage={() => setManageOpen(true)} />
            ) : (
              <ShortcutsTab />
            )}
          </div>
        </div>
      </div>,
      document.body
      )}

      {manageOpen && <MemoryManageModal onClose={() => setManageOpen(false)} />}
    </>
  )
}

function PersonalizationTab({ onManage }) {
  return (
    <div>
      <h2 style={{
        margin: '0 0 16px', fontSize: 'var(--text-2xl)', fontWeight: 700,
        color: 'var(--text-heading)', borderBottom: '1px solid var(--border-default)',
        paddingBottom: 16
      }}>
        Personalization
      </h2>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-heading)' }}>
            Memory
          </h3>
          <p style={{ margin: 0, maxWidth: 420, fontSize: 'var(--text-base)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Ask AI remembers details from your chats to personalize responses.
          </p>
        </div>
        <button
          onClick={onManage}
          style={{
            flex: 'none', height: 36, padding: '0 16px',
            border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-md)',
            background: '#fff', color: 'var(--text-heading)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Manage
        </button>
      </div>
    </div>
  )
}

// Static reference — nothing here is configurable, so it's plain content
// rather than a settings form. "Not available on this screen" entries
// (page-context shortcuts) are dimmed rather than omitted, matching GHL:
// the shortcut EXISTS, it just has nothing to act on from Co-Pilot's own
// tab, unlike a page with selectable page elements.
const SHORTCUT_GROUPS = [
  {
    title: 'General',
    rows: [{ label: 'Keyboard shortcuts', keys: ['⌘', '/'] }]
  },
  {
    title: 'Page context',
    rows: [
      { label: 'Select page element', sub: 'Not available on this screen', keys: ['⌘', '⇧', 'E'], dimmed: true },
      { label: 'Interact with the page (hold)', sub: 'Not available on this screen', keys: ['⇧'], dimmed: true }
    ]
  },
  {
    title: 'In chat',
    rows: [
      { label: 'Send message', keys: ['↵'] },
      { label: 'New line in message', keys: ['⇧', '↵'] },
      { label: 'Stop response or cancel picker', keys: ['Esc'] }
    ]
  }
]

function ShortcutsTab() {
  return (
    <div>
      <h2 style={{
        margin: '0 0 16px', fontSize: 'var(--text-2xl)', fontWeight: 700,
        color: 'var(--text-heading)', borderBottom: '1px solid var(--border-default)',
        paddingBottom: 16
      }}>
        Keyboard shortcuts
      </h2>
      <div style={{ display: 'grid', gap: 20 }}>
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.title}>
            <h3 style={{
              margin: '0 0 8px', fontSize: 'var(--text-base)', fontWeight: 600,
              color: 'var(--text-muted)'
            }}>
              {group.title}
            </h3>
            <div style={{ display: 'grid', gap: 10 }}>
              {group.rows.map((row) => (
                <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                      margin: 0, fontSize: 'var(--text-md)',
                      color: row.dimmed ? 'var(--text-faint)' : 'var(--text-heading)'
                    }}>
                      {row.label}
                    </p>
                    {row.sub && (
                      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
                        {row.sub}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                    {row.keys.map((k, i) => (
                      <kbd
                        key={i}
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          minWidth: 28, height: 28, padding: '0 6px',
                          border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
                          background: row.dimmed ? 'var(--gray-25)' : 'var(--gray-50)',
                          color: row.dimmed ? 'var(--text-faint)' : 'var(--text-body)',
                          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 600
                        }}
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
