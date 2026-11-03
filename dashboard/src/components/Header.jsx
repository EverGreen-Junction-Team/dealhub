import React from 'react'
import { Avatar, Tag } from 'antd'
import { useAuth } from '../context/AuthContext'
import Logo from './Logo'

// Initials from a display name, for the user avatar.
function initials(name) {
  if (!name) return '?'
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('')
}

export default function Header() {
  const { ghlContext } = useAuth()
  return (
    <header className="bg-white/90 backdrop-blur border-b border-gray-200 px-4 sm:px-6 py-3 flex items-center justify-between sticky top-0 z-20">
      <Logo />
      <div className="flex items-center gap-3">
        <Tag color="green" className="rounded-full !px-3 !py-0.5 hidden sm:inline-flex items-center gap-1.5 font-medium !border-green-200">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
          Live
        </Tag>
        {ghlContext?.userName && (
          <span className="text-sm text-gray-600 hidden md:inline">{ghlContext.userName}</span>
        )}
        <Avatar size={32} style={{ background: '#234fd6', fontSize: 'var(--text-md)', fontWeight: 600 }}>
          {initials(ghlContext?.userName)}
        </Avatar>
      </div>
    </header>
  )
}
