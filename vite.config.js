import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/upload': 'http://localhost:8000',
      '/extract': 'http://localhost:8000',
      '/frame': 'http://localhost:8000',
      '/download': 'http://localhost:8000',
      '/session': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
    },
  },
})
