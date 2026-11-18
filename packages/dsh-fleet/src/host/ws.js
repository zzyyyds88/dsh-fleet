/**
 * Minimal RFC 6455 client over an arbitrary duplex stream.
 *
 * The remote Host's stream carrier (`/api/remote.mux`) is reachable only through
 * an SSH `direct-tcpip` channel, so there is no `WebSocket` global to use: Node's
 * built-in client insists on owning a TCP socket. This module implements just
 * enough of the protocol for the carrier — text frames, ping/pong, close — and
 * nothing else. No extensions, no fragmentation on send, no permessage-deflate.
 *
 * @module @zzyyyds88/dsh-fleet/host/ws
 */
import { randomBytes } from 'node:crypto'

const OPCODE = Object.freeze({ TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa })

/** Encode one client-to-server text frame, masked as the protocol requires. */
function encodeText(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, 0x80 | length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

/** Encode a small control frame (close/pong) with a masked empty or given payload. */
function encodeControl(opcode, payload = Buffer.alloc(0)) {
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(payload.length)
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4]
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked])
}

/**
 * A live carrier connection.
 *
 * `onText` receives every complete text frame; `onClose` receives the single
 * terminal event. Callers own the underlying stream and close it through
 * {@link WebSocketClient#close}.
 */
export class WebSocketClient {
  /**
   * @param {import('node:stream').Duplex} stream - an already-upgraded duplex.
   * @param {{ onText: (text: string) => void, onClose: (reason?: string) => void }} handlers
   */
  constructor(stream, handlers) {
    this.stream = stream
    this.handlers = handlers
    this.closed = false
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0)
    this.onData = chunk => this.#consume(chunk)
    this.onStreamClose = () => this.#finish('the carrier stream closed')
    this.onStreamError = error => this.#finish(error instanceof Error ? error.message : String(error))
    stream.on('data', this.onData)
    stream.on('close', this.onStreamClose)
    stream.on('error', this.onStreamError)
  }

  /** Send one text frame. A closed socket drops the write instead of throwing. */
  send(text) {
    if (this.closed) return false
    try {
      this.stream.write(encodeText(text))
      return true
    } catch {
      this.#finish('the carrier write failed')
      return false
    }
  }

  /** Send a close frame and destroy the stream. */
  close() {
    if (this.closed) return
    try { this.stream.write(encodeControl(OPCODE.CLOSE, Buffer.from([0x03, 0xe8]))) } catch { /* closing anyway */ }
    this.#finish('closed by this plugin')
  }

  #finish(reason) {
    if (this.closed) return
    this.closed = true
    this.stream.off('data', this.onData)
    this.stream.off('close', this.onStreamClose)
    this.stream.off('error', this.onStreamError)
    try { this.stream.destroy() } catch { /* already gone */ }
    try { this.handlers.onClose(reason) } catch { /* a listener must not break teardown */ }
  }

  /** Parse as many complete frames as the buffer holds. */
  #consume(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f
      const second = this.buffer[1]
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const wide = this.buffer.readBigUInt64BE(2)
        if (wide > BigInt(64 * 1024 * 1024)) {
          this.#finish('the carrier sent an oversized frame')
          return
        }
        length = Number(wide)
        offset = 10
      }
      const maskBytes = masked ? 4 : 0
      if (this.buffer.length < offset + maskBytes + length) return
      let payload = this.buffer.subarray(offset + maskBytes, offset + maskBytes + length)
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4)
        const unmasked = Buffer.allocUnsafe(length)
        for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ mask[index % 4]
        payload = unmasked
      }
      this.buffer = this.buffer.subarray(offset + maskBytes + length)

      if (opcode === OPCODE.TEXT) {
        try { this.handlers.onText(payload.toString('utf8')) } catch { /* listener fault */ }
      } else if (opcode === OPCODE.PING) {
        try { this.stream.write(encodeControl(OPCODE.PONG, payload)) } catch { /* closing */ }
      } else if (opcode === OPCODE.CLOSE) {
        this.#finish('the carrier closed')
        return
      }
    }
  }
}

/**
 * Perform a WebSocket upgrade over one duplex and hand back the live client.
 * @param {import('node:stream').Duplex} stream
 * @param {{ host: string, path: string, origin: string, cookie?: string, headers?: Record<string, string>, connectTimeoutMs?: number }} options
 * @param {{ onText: (text: string) => void, onClose: (reason?: string) => void }} handlers
 * @returns {Promise<WebSocketClient>}
 */
export function upgradeWebSocket(stream, options, handlers) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    let head = Buffer.alloc(0)
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`the stream carrier did not answer within ${String(options.connectTimeoutMs ?? 20_000)} ms`))
    }, options.connectTimeoutMs ?? 20_000)
    timeout.unref?.()

    const cleanup = () => {
      clearTimeout(timeout)
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('close', onClose)
    }
    const fail = error => {
      if (settled) return
      settled = true
      cleanup()
      try { stream.destroy() } catch { /* already gone */ }
      reject(error)
    }
    const onError = error => fail(error instanceof Error ? error : new Error(String(error)))
    const onClose = () => fail(new Error('the carrier stream closed before the upgrade completed'))
    const onData = chunk => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) {
        if (head.length > 64 * 1024) fail(new Error('the carrier sent an oversized upgrade response'))
        return
      }
      const text = head.subarray(0, end).toString('utf8')
      const status = /^HTTP\/1\.1 (\d{3})/u.exec(text)
      if (status === null) return fail(new Error('the carrier sent a malformed upgrade response'))
      if (status[1] !== '101') {
        // The status travels with the error: an upgrade refused with 401 is the ordinary
        // way a restarted resident host answers with a cookie minted by the previous one,
        // and the caller can only tell that case apart if it knows the number.
        return fail(Object.assign(new Error(`the carrier refused the upgrade with HTTP ${status[1]}`), {
          status: Number(status[1]),
        }))
      }
      if (!/^upgrade:\s*websocket$/imu.test(text)) {
        return fail(new Error('the carrier answered 101 without a WebSocket upgrade'))
      }
      settled = true
      cleanup()
      const client = new WebSocketClient(stream, handlers)
      const rest = head.subarray(end + 4)
      resolve(client)
      if (rest.length > 0) stream.emit('data', rest)
    }

    stream.on('data', onData)
    stream.on('error', onError)
    stream.on('close', onClose)
    const lines = [
      `GET ${options.path} HTTP/1.1`,
      `Host: ${options.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      `Origin: ${options.origin}`,
    ]
    if (options.cookie !== undefined && options.cookie.length > 0) lines.push(`Cookie: ${options.cookie}`)
    for (const [name, value] of Object.entries(options.headers ?? {})) lines.push(`${name}: ${value}`)
    try {
      stream.write(`${lines.join('\r\n')}\r\n\r\n`)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
