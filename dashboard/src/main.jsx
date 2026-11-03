import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import App from './App.jsx'
import './index.css'

// Brand theme for antd.
//
// These values MIRROR styles/dealhub-tokens.css. They were divergent — antd
// was themed blue (#3563e9) with system fonts while the Deal Hub is evergreen
// with Poppins, so the same app had two visual identities depending on which
// component you were looking at.
//
// Kept as literals rather than reading the CSS variables because antd resolves
// its theme in JS at render time and cannot see them. If a token changes in the
// CSS, change it here too.
const theme = {
  token: {
    colorPrimary: '#1f7a5c',        // --green-500
    colorSuccess: '#00a25b',        // --status-done
    colorWarning: '#f5a300',        // --status-working
    colorError: '#d83a52',          // --status-stuck
    colorTextBase: '#323844',       // --gray-700
    colorBorder: '#dcdfe4',         // --gray-200
    colorBgLayout: '#f5f6f8',       // --gray-50
    borderRadius: 8,                // --radius-md
    fontFamily: "'Poppins', -apple-system, 'Segoe UI', sans-serif",
    fontSize: 13,                   // --text-md, the app's body size
    controlHeight: 36,              // --control-h-md
    colorTextPlaceholder: '#6b7482', // --gray-450, AA on white
  },
  components: {
    // antd's default input border is lighter than the app's, so a native
    // control and an antd one sat side by side didn't match. These pin the
    // three the Deal cards use.
    Input: { colorBorder: '#c3c8d0', activeBorderColor: '#16855f' },
    DatePicker: { colorBorder: '#c3c8d0', activeBorderColor: '#16855f' },
    Select: { colorBorder: '#c3c8d0', optionSelectedBg: '#d8ede4' },
  },
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider theme={theme}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
)
