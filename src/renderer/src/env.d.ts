/// <reference types="vite/client" />
import type { ManabiApi } from '../../preload'

declare global {
  interface Window {
    manabi: ManabiApi
  }
}

export {}
