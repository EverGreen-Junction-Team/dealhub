import React from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { LoadingScreen, ErrorScreen } from './components/Screens'
import DealHubShell from './pages/DealHubShell'

// Single-page shell inside the GHL iframe. No URL routing — tab-state
// navigation matches how ConvoVault and Telegram work (iframe embeds don't
// play well with browser URLs).
function AppContent() {
  const { loading, error, isAuthenticated } = useAuth()
  if (loading) return <LoadingScreen />
  if (error) return <ErrorScreen error={error} />
  if (!isAuthenticated)
    return <ErrorScreen error="Not authenticated. Please install PipelinePulse on this sub-account." />
  return <DealHubShell />
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
