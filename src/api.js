/**
 * API base URL helper.
 * - In development:  Vite proxy forwards /upload, /extract … to localhost:8000
 *   so API_BASE stays empty and calls are relative.
 * - In production:   Set VITE_API_URL=https://frameforge-backend.onrender.com
 *   in Vercel → Project Settings → Environment Variables.
 */
export const API_BASE = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/$/, '')   // strip trailing slash
  : '';

/**
 * Convenience wrapper — prepends API_BASE to any path.
 * Usage:  apiUrl('/upload')  →  'https://xxx.onrender.com/upload'  (prod)
 *                           →  '/upload'                           (dev)
 */
export const apiUrl = (path) => `${API_BASE}${path}`;
