import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import App from './App.jsx'
import { BASE_THEME } from './theme'
import './index.css'

// The theme at its unscaled size. AppearanceProvider nests a second
// ConfigProvider inside this one once the saved text size is known, and antd
// merges nested providers — so this is what the sign-in and error screens
// use, and everything past the auth gate uses the scaled copy.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider theme={BASE_THEME}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
)
