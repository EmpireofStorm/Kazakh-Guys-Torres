import React from 'react'
import { createRoot } from 'react-dom/client'
import { OverlayApp } from './OverlayApp'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing root')
createRoot(root).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>
)
