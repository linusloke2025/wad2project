import axios from 'axios'

/**
 * The API client.
 *
 * Built as a factory taking a token getter and an unauthorised handler, rather than importing a
 * store directly. That keeps it testable and avoids a circular import between the store and the
 * client — the store owns the token, the client only reads it.
 *
 * A 401 means the session is gone (expired or revoked), so the handler clears it and the router
 * sends the user back to login. Handling it centrally is what stops every view needing its own
 * "am I still logged in?" branch.
 */
export function createApiClient({ getToken, onUnauthorized, baseURL = '/api' } = {}) {
  const client = axios.create({ baseURL })

  client.interceptors.request.use((config) => {
    const token = getToken?.()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  })

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401) {
        onUnauthorized?.()
      }
      return Promise.reject(error)
    },
  )

  return client
}

/**
 * Turn an axios failure into something a person can read.
 *
 * A bare "Request failed with status code 403" tells a user nothing; the API already returns a
 * useful message, so prefer it.
 */
export function describeError(error) {
  if (error?.response?.data?.error) return error.response.data.error
  if (error?.message) return error.message
  return 'Something went wrong. Please try again.'
}
