import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { aiAPI } from '../../api/ai'

// "Saved memories" — the panel behind Personalization's Manage button.
// Explicit save + bulk import only; see server/migrations/075_ai_memories.sql
// for why there's no automatic mid-chat extraction like GHL's own memory
// service.
export default function MemoryManageModal({ onClose }) {
  const [memories, setMemories] = useState(null)   // null = loading
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [sortDesc, setSortDesc] = useState(true)    // newest first, matching the server's default order
  const [deletingIds, setDeletingIds] = useState(() => new Set())
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const load = () => {
    aiAPI.listMemories()
      .then((r) => setMemories(r?.memories || []))
      .catch(() => { setMemories([]); setError('Could not load memories.') })
  }
  useEffect(load, [])

  const filtered = useMemo(() => {
    const list = memories || []
    const q = search.trim().toLowerCase()
    const matched = q ? list.filter((m) => m.content.toLowerCase().includes(q)) : list
    // The server already returns newest-first; sortDesc toggles that view
    // without a second request — the list is at most 200 rows.
    return sortDesc ? matched : [...matched].reverse()
  }, [memories, search, sortDesc])

  const deleteOne = async (id) => {
    setDeletingIds((prev) => new Set(prev).add(id))
    try {
      await aiAPI.deleteMemory(id)
      setMemories((prev) => (prev || []).filter((m) => m.id !== id))
    } catch {
      setError('Could not delete that memory.')
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const clearAll = async () => {
    setClearConfirmOpen(false)
    try {
      await aiAPI.deleteAllMemories()
      setMemories([])
    } catch {
      setError('Could not clear memories.')
    }
  }

  const loading = memories === null

  return (
    <>
      {createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Saved memories"
        className="pp-portal"
        onMouseDown={(e) => { if (e.target === e.currentTarget && !clearConfirmOpen && !importOpen) onClose() }}
        style={{
          position: 'fixed', inset: 0, zIndex: 920,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(15, 23, 42, 0.32)',
          backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
          padding: 16
        }}
      >
        <div style={{
          width: 'min(720px, 100%)', height: 'min(600px, 90vh)',
          background: '#fff',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-overlay)',
          display: 'grid', gridTemplateRows: 'auto auto auto 1fr',
          overflow: 'hidden'
        }}>
          <div style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
            gap: 16, padding: '20px 24px 0'
          }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--text-heading)' }}>
                Saved memories
              </h2>
              <p style={{ margin: '4px 0 0', maxWidth: 460, fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                Ask AI tries to remember important details from your chats. Saved memories are never forgotten.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
              <button
                onClick={() => setImportOpen(true)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  height: 36, padding: '0 14px',
                  border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-md)',
                  background: '#fff', color: 'var(--text-heading)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <span className="ms" style={{ fontSize: 17 }}>upload</span>
                Import memories
              </button>
              <button
                onClick={onClose}
                aria-label="Close"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 32, height: 32, border: 'none', borderRadius: 'var(--radius-sm)',
                  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer'
                }}
              >
                <span className="ms" style={{ fontSize: 20 }}>close</span>
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 24px 0' }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search memories"
              style={{
                flex: 1, height: 38, padding: '0 12px', boxSizing: 'border-box',
                border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', color: 'var(--text-heading)'
              }}
            />
            <button
              title={sortDesc ? 'Sort oldest first' : 'Sort newest first'}
              onClick={() => setSortDesc((d) => !d)}
              disabled={!memories?.length}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 38, height: 38, flex: 'none',
                border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
                background: '#fff', color: memories?.length ? 'var(--text-muted)' : 'var(--text-faint)',
                cursor: memories?.length ? 'pointer' : 'default'
              }}
            >
              <span className="ms" style={{ fontSize: 18 }}>sort</span>
            </button>
            <button
              title="Clear all memories"
              onClick={() => setClearConfirmOpen(true)}
              disabled={!memories?.length}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 38, height: 38, flex: 'none',
                border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
                background: '#fff', color: memories?.length ? 'var(--text-muted)' : 'var(--text-faint)',
                cursor: memories?.length ? 'pointer' : 'default'
              }}
            >
              <span className="ms" style={{ fontSize: 18 }}>delete</span>
            </button>
          </div>

          <div style={{ borderBottom: '1px solid var(--border-default)', margin: '16px 0 0' }} />

          <div style={{ minHeight: 0, overflowY: 'auto', padding: '0 24px 20px' }}>
            {error && (
              <p style={{
                margin: '14px 0 0', padding: '8px 12px',
                borderRadius: 'var(--radius-sm)', background: 'var(--tint-rose)',
                color: 'var(--status-stuck-text)', fontSize: 'var(--text-base)'
              }}>
                {error}
              </p>
            )}

            {loading ? (
              <div style={{ display: 'grid', gap: 10, paddingTop: 16 }}>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} style={{ height: 20, borderRadius: 4, background: 'var(--gray-100)' }} />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 8, paddingTop: 100, color: 'var(--text-faint)'
              }}>
                <span className="ms" style={{ fontSize: 32 }}>edit_note</span>
                <p style={{ margin: 0, fontSize: 'var(--text-md)' }}>
                  {search ? `No memories matching "${search}".` : 'No saved memories yet.'}
                </p>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 4, paddingTop: 8 }}>
                {filtered.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                      padding: '10px 8px', borderRadius: 'var(--radius-sm)'
                    }}
                  >
                    <p style={{
                      flex: 1, minWidth: 0, margin: 0,
                      fontSize: 'var(--text-md)', color: 'var(--text-body)', lineHeight: 1.5
                    }}>
                      {m.content}
                    </p>
                    <button
                      title="Delete this memory"
                      disabled={deletingIds.has(m.id)}
                      onClick={() => deleteOne(m.id)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 30, height: 30, flex: 'none',
                        border: 'none', borderRadius: 'var(--radius-sm)',
                        background: 'transparent', color: 'var(--text-faint)',
                        cursor: deletingIds.has(m.id) ? 'default' : 'pointer'
                      }}
                    >
                      <span className="ms" style={{ fontSize: 17 }}>delete</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body
      )}

      {clearConfirmOpen && (
        <ClearAllConfirm onCancel={() => setClearConfirmOpen(false)} onConfirm={clearAll} />
      )}

      {importOpen && (
        <MemoryImportModal
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); load() }}
        />
      )}
    </>
  )
}

function ClearAllConfirm({ onCancel, onConfirm }) {
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="pp-portal"
      style={{
        position: 'fixed', inset: 0, zIndex: 940,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15, 23, 42, 0.4)', padding: 16
      }}
    >
      <div style={{
        width: 'min(400px, 100%)', background: '#fff',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-overlay)',
        padding: 20, display: 'grid', gap: 12
      }}>
        <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-heading)' }}>
          Clear all memories?
        </h3>
        <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
          This removes everything Ask AI remembers about you. This can't be undone.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{
              height: 36, padding: '0 14px', border: 'none', background: 'transparent',
              color: 'var(--text-heading)', fontWeight: 600,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              height: 36, padding: '0 16px', border: 'none', borderRadius: 'var(--radius-md)',
              background: 'var(--status-stuck)', color: '#fff', fontWeight: 600,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', cursor: 'pointer'
            }}
          >
            Clear all
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// A pasted list — one memory per line — or the output of asking Co-Pilot to
// export its memories (GHL's own EXPORT_PROMPT produces a dated, categorised
// list; a plain line-per-memory paste works the same way here since import
// doesn't need the date/category structure, just the content).
function MemoryImportModal({ onClose, onImported }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  const submit = async () => {
    if (!lines.length || busy) return
    setBusy(true)
    setError(null)
    try {
      await aiAPI.importMemories(lines)
      onImported()
    } catch {
      setError('Could not import memories.')
      setBusy(false)
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="pp-portal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 940,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15, 23, 42, 0.4)', padding: 16
      }}
    >
      <div style={{
        width: 'min(520px, 100%)', background: '#fff',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-overlay)',
        padding: 20, display: 'grid', gap: 12
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-heading)' }}>
            Import memories
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, border: 'none', borderRadius: 'var(--radius-sm)',
              background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
          Paste one memory per line.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={'I run a glazing business in Manchester\nPrefers short, direct answers'}
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical',
            padding: '10px 12px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', color: 'var(--text-heading)'
          }}
        />
        {error && (
          <p style={{ margin: 0, color: 'var(--status-stuck-text)', fontSize: 'var(--text-base)' }}>{error}</p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              height: 36, padding: '0 14px', border: 'none', background: 'transparent',
              color: 'var(--text-heading)', fontWeight: 600,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              cursor: busy ? 'default' : 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!lines.length || busy}
            style={{
              height: 36, padding: '0 16px', border: 'none', borderRadius: 'var(--radius-md)',
              background: lines.length && !busy ? 'var(--brand-primary)' : 'var(--gray-200)',
              color: lines.length && !busy ? '#fff' : 'var(--text-faint)',
              fontWeight: 600, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              cursor: lines.length && !busy ? 'pointer' : 'default'
            }}
          >
            Import {lines.length || ''}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
