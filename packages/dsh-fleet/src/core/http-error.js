/**
 * The error shape every `/nodes` route answers with, so a browser surface can
 * branch on `code` instead of parsing prose.
 * @module @zzyyyds88/dsh-fleet/core/http-error
 */

/**
 * Build one routable route failure.
 * @param {string} code - stable machine-readable discriminator.
 * @param {string} message - operator-facing explanation.
 * @param {number} [status] - HTTP status this failure is answered with.
 */
export function apiError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

/**
 * Serialize one thrown value for a route response.
 * @param {unknown} error
 */
export function describeFailure(error) {
  if (error instanceof Error) {
    return {
      status: typeof error.status === 'number' ? error.status : 500,
      code: typeof error.code === 'string' ? error.code : 'fleet-failed',
      error: error.message,
    }
  }
  return { status: 500, code: 'fleet-failed', error: String(error) }
}

/**
 * Read and parse one JSON request body with a byte ceiling.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 */
export async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw apiError('body-too-large', `request body exceeds ${String(maxBytes)} bytes`, 413)
    chunks.push(buffer)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw apiError('invalid-json', 'request body is not valid JSON', 400)
  }
}

/**
 * Answer one route with a JSON envelope.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
export function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}
