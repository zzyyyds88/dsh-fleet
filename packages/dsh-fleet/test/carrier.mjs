/**
 * A minimal RFC 6455 client for the tests.
 *
 * Two details matter and both are easy to miss:
 *
 *   - The Gateway pings every 2 s (`websocketHeartbeatIntervalMs`, default 2000)
 *     and **closes a socket that never answers**. A test client that ignores
 *     `PING` looks fine for two seconds and then silently loses its stream — which
 *     is exactly what makes a routing bug look like a transport bug.
 *   - Frames can arrive fragmented across TCP reads, so the decoder must buffer.
 *
 * @module @greatbaby/dsh-fleet/test/carrier
 */
import { randomBytes } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { decodeGatewayAnswer } from '../src/host/multipart.js'

const OPCODE = Object.freeze({ TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa })

/** Mask and frame one client-to-server message. */
function encode(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

/**
 * Upgrade one TCP socket to a WebSocket and answer every keepalive.
 *
 * @param {{ base: string, cookie: string, path?: string, connectTimeoutMs?: number }} options
 * @returns {Promise<{ send: (text: string) => void, onMessage: (fn: (text: string) => void) => () => void, close: () => void, closed: () => boolean }>}
 */
export function openCarrier(options) {
  const url = new URL(options.base)
  const path = options.path ?? '/api/remote.mux'
  return new Promise((resolve, reject) => {
    const socket = netConnect(Number(url.port), url.hostname)
    let buffer = Buffer.alloc(0)
    let upgraded = false
    let closed = false
    const listeners = new Set()
    const sendRaw = (opcode, payload) => {
      if (closed) return
      try { socket.write(encode(opcode, payload)) } catch { /* the socket is gone */ }
    }
    const send = text => sendRaw(OPCODE.TEXT, Buffer.from(text, 'utf8'))

    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = buffer.subarray(0, end).toString('utf8')
        const status = /^HTTP\/1\.1 (\d{3})/u.exec(head)
        if (status === null) return reject(new Error('malformed upgrade response'))
        if (status[1] !== '101') {
          return reject(new Error(`upgrade refused: HTTP ${status[1]} — ${head.slice(0, 200)}`))
        }
        upgraded = true
        buffer = buffer.subarray(end + 4)
        resolve({
          send,
          onMessage: fn => { listeners.add(fn); return () => listeners.delete(fn) },
          close: () => { closed = true; try { socket.destroy() } catch { /* gone */ } },
          closed: () => closed,
        })
        if (buffer.length === 0) return
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f
        const second = buffer[1]
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          const wide = buffer.readBigUInt64BE(2)
          if (wide > BigInt(64 * 1024 * 1024)) {
            try { socket.destroy() } catch { /* gone */ }
            return
          }
          length = Number(wide)
          offset = 10
        }
        const maskBytes = masked ? 4 : 0
        if (buffer.length < offset + maskBytes + length) return
        let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + length)
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4)
          const out = Buffer.allocUnsafe(length)
          for (let index = 0; index < length; index += 1) out[index] = payload[index] ^ mask[index % 4]
          payload = out
        }
        buffer = buffer.subarray(offset + maskBytes + length)
        if (opcode === OPCODE.TEXT) {
          const text = payload.toString('utf8')
          for (const fn of [...listeners]) fn(text)
        } else if (opcode === OPCODE.PING) {
          // The Gateway's 2 s heartbeat closes a socket that never answers.
          sendRaw(OPCODE.PONG, payload)
        } else if (opcode === OPCODE.CLOSE) {
          closed = true
          try { socket.destroy() } catch { /* gone */ }
          return
        }
      }
    }

    socket.on('data', onData)
    socket.on('error', error => {
      if (!upgraded) reject(error)
      else closed = true
    })
    socket.on('close', () => { closed = true })
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\n`
      + 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n'
      + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`
      + `Origin: ${url.origin}\r\n`
      + `${options.cookie.length > 0 ? `Cookie: ${options.cookie}\r\n` : ''}\r\n`,
    )
    const timer = setTimeout(() => {
      if (upgraded) return
      try { socket.destroy() } catch { /* gone */ }
      reject(new Error(`the carrier did not upgrade within ${String(options.connectTimeoutMs ?? 20_000)} ms`))
    }, options.connectTimeoutMs ?? 20_000)
    timer.unref?.()
  })
}

/**
 * Open one logical stream and keep its frames in a growing array.
 * @param {Awaited<ReturnType<typeof openCarrier>>} carrier
 * @param {string} endpoint
 * @param {Record<string, unknown>} args
 */
export function liveStream(carrier, endpoint, args) {
  const streamId = `t-${randomBytes(6).toString('hex')}`
  const frames = []
  const off = carrier.onMessage(text => {
    let parsed
    try { parsed = JSON.parse(text) } catch { return }
    if (parsed.streamId === streamId) frames.push(parsed)
  })
  carrier.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
  return {
    frames,
    streamId,
    stop: () => {
      off()
      carrier.send(JSON.stringify({ type: 'cancel', streamId }))
    },
  }
}

/** Exchange the launch token for the Host browser cookie. */
export async function authenticate(base, token) {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const raw = response.headers.getSetCookie?.() ?? []
  if (raw.length === 0) throw new Error(`the Host did not set a cookie (HTTP ${String(response.status)})`)
  return raw.map(entry => entry.split(';', 1)[0].trim()).filter(Boolean).join('; ')
}

/** One HTTP GET as the authenticated browser. */
export async function get(base, cookie, path) {
  const response = await fetch(`${base}${path}`, { headers: cookie.length > 0 ? { cookie } : {} })
  return { status: response.status, text: await response.text() }
}

/**
 * The client-plugin bundles the shell serves, as absolute URLs.
 *
 * The shell splits its plugin bundles across several `plugins/??a,b,c` combos and a
 * plugin can land in any of them, so a caller has to look inside each list rather
 * than assume a fixed path.
 * @param {string} base
 * @param {string} cookie
 * @returns {Promise<Array<{ path: string, names: string[] }>>}
 */
export async function clientBundles(base, cookie) {
  const index = await get(base, cookie, '/')
  if (index.status !== 200) throw new Error(`the Host index answered HTTP ${String(index.status)}`)
  const combos = index.text.match(/plugins\/\?\?[^"']+/gu) ?? []
  return combos.map(combo => {
    const clean = combo.replaceAll('&amp;', '&')
    const query = clean.slice('plugins/??'.length)
    const names = query.split('&')[0].split(',').map(name => decodeURIComponent(name))
    return { path: `/${clean}`, names }
  })
}

/**
 * The client-plugin bundle that contains one plugin id.
 * @param {string} base
 * @param {string} cookie
 * @param {string} pluginId - e.g. `@greatbaby/dsh-fleet/client.js`.
 * @returns {Promise<{ url: string, text: string } | undefined>}
 */
export async function clientBundleFor(base, cookie, pluginId) {
  const bundles = await clientBundles(base, cookie)
  for (const bundle of bundles) {
    if (!bundle.names.includes(pluginId)) continue
    const response = await get(base, cookie, bundle.path)
    if (response.status !== 200) throw new Error(`the client bundle answered HTTP ${String(response.status)}`)
    return { url: `${base}${bundle.path}`, text: response.text }
  }
  return undefined
}

/** One Gateway unary call against the local Host. */
export async function call(base, cookie, endpoint, args) {
  const payload = JSON.stringify({
    type: 'client-request',
    rpcId: `t-${randomBytes(6).toString('hex')}`,
    method: endpoint,
    payload: { args },
  })
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: payload,
  })
  if (response.status !== 200) {
    throw new Error(`${endpoint}: HTTP ${String(response.status)} ${(await response.text()).slice(0, 200)}`)
  }
  // A result carrying bytes comes back as multipart, not JSON — the same shape
  // the browser client decodes. `workspaceFiles/readBytes` is the common case.
  const contentType = response.headers.get('content-type') ?? ''
  const body = Buffer.from(await response.arrayBuffer())
  let parsed
  try {
    parsed = { result: decodeGatewayAnswer(body, contentType) }
  } catch (error) {
    throw new Error(`${endpoint}: ${error.message}`)
  }
  if (parsed.result?.ok !== true) {
    throw Object.assign(new Error(parsed.result?.error?.message ?? `${endpoint} failed`), {
      code: parsed.result?.error?.code,
    })
  }
  return parsed.result.value
}
