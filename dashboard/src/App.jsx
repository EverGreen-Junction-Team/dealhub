import React from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { AppearanceProvider } from './context/AppearanceContext'
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
  // INSIDE the authentication gate. The preferences call needs the session
  // token, and the loading and error screens must draw at the app's default
  // size — they are what you see when nothing else works, including when the
  // preferences call is the thing that is not working.
  return (
    <AppearanceProvider>
      <DealHubShell />
    </AppearanceProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
