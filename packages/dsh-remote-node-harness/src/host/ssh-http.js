/**
 * HTTP and WebSocket plumbing over one SSH `direct-tcpip` channel.
 *
 * A node's resident Host listens on its loopback interface only. Every request
 * this plugin makes therefore rides a forwarded channel on the pooled SSH
 * connection; there is no second transport and no listening port on either
 * side.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/ssh-http
 */
import { request as httpRequest } from 'node:http'

/**
 * Adapt one SSH channel to the socket shape `node:http` expects. An SSH channel
 * has no TCP options to set, so the tuning methods are chainable no-ops.
 * @param {import('node:stream').Duplex} stream
 */
export function asSocket(stream) {
  stream.ref ??= () => stream
  stream.unref ??= () => stream
  stream.setKeepAlive ??= () => stream
  stream.setNoDelay ??= () => stream
  stream.setTimeout ??= () => stream
  return stream
}

/**
 * Open one forwarded channel to a port on the remote loopback.
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {number} port
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ stream: import('node:stream').Duplex, close: () => void }>}
 */
export function openChannel(connection, port, signal) {
  return connection.forwardOut('127.0.0.1', port, signal)
}

/**
 * Perform one complete HTTP/1.1 exchange over a fresh forwarded channel.
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {number} port
 * @param {{ path: string, method?: string, headers?: Record<string, string>, body?: string | Buffer }} init
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer }>}
 */
export async function httpOverSsh(connection, port, init) {
  const channel = await openChannel(connection, port)
  try {
    return await new Promise((resolve, reject) => {
      const upstream = httpRequest({
        host: '127.0.0.1',
        port,
        method: init.method ?? 'GET',
        path: init.path,
        headers: { host: `127.0.0.1:${String(port)}`, connection: 'close', ...init.headers },
        createConnection: () => asSocket(channel.stream),
      })
      upstream.on('error', reject)
      upstream.on('response', response => {
        const chunks = []
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })
        })
        response.on('error', reject)
      })
      if (init.body !== undefined) upstream.write(init.body)
      upstream.end()
    })
  } finally {
    channel.close()
  }
}

/**
 * Read every `Set-Cookie` header as a `name=value` list.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string[]}
 */
export function cookiesOf(headers) {
  const raw = headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  return list.map(cookie => cookie.split(';')[0].trim()).filter(cookie => cookie.length > 0)
}
