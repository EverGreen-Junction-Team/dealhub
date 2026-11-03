import React from 'react'
import { Card, Descriptions, Tag, Alert } from 'antd'
import { CheckCircleFilled } from '@ant-design/icons'
import Header from './Header'
import { useAuth } from '../context/AuthContext'

// Post-authentication landing screen.
//
// This is intentionally minimal: it proves the GHL iframe embed + postMessage
// auth handshake works end-to-end, and surfaces the exact sub-account context
// the app resolved. It is the starting point for feature development — new
// screens mount here once the session is established.
export default function Dashboard() {
  const { ghlContext, location, session } = useAuth()

  return (
    <div className="min-h-full">
      <Header />
      <div className="max-w-[880px] mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <CheckCircleFilled style={{ color: '#22c55e', fontSize: 'var(--text-2xl)' }} />
          <div>
            <h1 className="text-xl font-bold text-gray-900 m-0">Connected</h1>
            <p className="text-sm text-gray-500 m-0">
              Authenticated — sub-account context resolved automatically.
            </p>
          </div>
        </div>

        <Card className="mb-5" title="Sub-account context" size="small">
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Location name">
              {location?.name || <span className="text-gray-400">—</span>}
            </Descriptions.Item>
            <Descriptions.Item label="Location ID">
              <code>{ghlContext?.locationId || '—'}</code>
            </Descriptions.Item>
            <Descriptions.Item label="Company ID">
              <code>{ghlContext?.companyId || '—'}</code>
            </Descriptions.Item>
            <Descriptions.Item label="User">
              {ghlContext?.userName || '—'}
              {ghlContext?.email ? ` · ${ghlContext.email}` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="Role / type">
              <Tag>{ghlContext?.role || 'user'}</Tag>
              <Tag color="blue">{ghlContext?.type || 'Location'}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Session">
              {session?.token ? (
                <Tag color="green">Active</Tag>
              ) : (
                <Tag color="orange">None</Tag>
              )}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Alert
          type="info"
          showIcon
          message="Development starter"
          description="Authentication and the sub-account handshake are wired and working. Build new features from this screen — the resolved session and location context are available via the useAuth() hook."
        />
      </div>
    </div>
  )
}
