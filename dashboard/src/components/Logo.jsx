import React from 'react'

// PipelinePulse wordmark + mark. The glyph is a stylized pulse/heartbeat line
// flowing through pipeline stages — "the pulse of your pipeline". Used in the
// header; scales via the `size` prop.
export function LogoMark({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden>
      <defs>
        <linearGradient id="ppg" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4f7dff" />
          <stop offset="1" stopColor="#234fd6" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill="url(#ppg)" />
      <path
        d="M6 22h7l3-9 5 16 3-11 2 4h8"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

export default function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark />
      <div className="font-extrabold text-gray-900 text-lg tracking-tight">
        Dashboard
      </div>
    </div>
  )
}
