export function safeMessage(code: string, status: number): string {
  if (status === 403) return "You do not have permission to complete this action."
  if (status === 404) return "This entity is unavailable."
  if (status === 409 && code === "revision_conflict")
    return "This item changed on the server. Reload the latest revision."
  if (status === 409 || status === 410)
    return "This result set can no longer continue. Restart the query."
  if (status >= 500) return "The server could not complete the request. Try again."
  return "The request could not be completed. Check the entered values."
}
