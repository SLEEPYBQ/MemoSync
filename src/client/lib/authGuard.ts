import { WS_UNAUTHORIZED_EVENT } from "../app/socket"

/**
 * Mid-session /api fetches only see 401 when the password session died
 * (rotated password, evicted cookie). Route that to the password gate —
 * the same signal the socket's reconnect probe uses — instead of leaving
 * the user a generic "Request failed (401)" toast. Returns the response
 * unchanged so callers keep their own error handling.
 */
export function notifyIfUnauthorized(response: Response): Response {
  if (response.status === 401) {
    window.dispatchEvent(new Event(WS_UNAUTHORIZED_EVENT))
  }
  return response
}
