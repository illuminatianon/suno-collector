let sessionToken = null
let sessionPromise = null

async function token() {
  if (sessionToken) return sessionToken
  if (!sessionPromise) {
    sessionPromise = fetch('/api/session', { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('Could not connect to the collector. Check that the server is running.')
      const data = await response.json()
      if (!data.token) throw new Error('The collector did not supply a library session.')
      sessionToken = data.token
      return sessionToken
    }).finally(() => { sessionPromise = null })
  }
  return sessionPromise
}

export async function api(path, signal, options = {}) {
  const bearer = await token()
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${bearer}`)
  const response = await fetch(path, { ...options, signal, headers, credentials: 'same-origin' })
  if (!response.ok) {
    if (response.status === 401) sessionToken = null
    const data = await response.json().catch(() => null)
    throw new Error(data?.error || (response.status === 404 ? 'This song is no longer in the library.' : `The collector returned HTTP ${response.status}. Try again.`))
  }
  return response.json()
}
