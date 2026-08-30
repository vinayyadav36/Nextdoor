import { ClerkProvider } from '@clerk/react';
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!PUBLISHABLE_KEY) {
  createRoot(document.getElementById('root')!).render(
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      padding: '24px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      textAlign: 'center',
      backgroundColor: '#f8fafc',
      color: '#0f172a'
    }}>
      <div style={{
        maxWidth: '450px',
        padding: '32px',
        borderRadius: '16px',
        backgroundColor: '#ffffff',
        boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
        border: '1px solid #e2e8f0'
      }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚙️</div>
        <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#e11d48', margin: '0 0 12px 0' }}>
          Configuration Missing
        </h2>
        <p style={{ fontSize: '13.5px', color: '#475569', lineHeight: '1.6', margin: '0 0 20px 0' }}>
          The required environment variable <strong>VITE_CLERK_PUBLISHABLE_KEY</strong> is not defined in your Appwrite/Vercel settings.
        </p>
        <div style={{
          fontSize: '12px',
          backgroundColor: '#f1f5f9',
          padding: '12px',
          borderRadius: '8px',
          fontFamily: 'monospace',
          textAlign: 'left',
          color: '#334155',
          border: '1px solid #cbd5e1',
          marginBottom: '20px'
        }}>
          VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
        </div>
        <p style={{ fontSize: '12px', color: '#64748b', margin: '0' }}>
          Please add it to your environment variables and redeploy.
        </p>
      </div>
    </div>
  )
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ClerkProvider>
    </StrictMode>
  )
}