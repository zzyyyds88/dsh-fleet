/**
 * The Gateway's `multipart/form-data` answers carry bytes, and getting them wrong
 * is invisible until a remote image preview fails.
 *
 * `workspaceFiles/readBytes` answers with a metadata part plus one part per byte
 * attachment; a client that JSON-parses either throws or, worse, returns `null`
 * where a `Uint8Array` belongs. This test builds the exact shape the Gateway
 * writes (see `dsh-client-connection/lib/index.js`) and asserts both directions:
 * attachments are restored, and a plain JSON answer is untouched.
 *
 * Usage: node test/multipart-unit.mjs
 */
import { decodeGatewayAnswer } from '../src/host/multipart.js'

const log = message => process.stderr.write(`[multipart-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const BOUNDARY = '----formdata-undici-0123456789'

/** Build one response the way the Gateway does. */
function multipart(envelope, parts) {
  const chunks = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`, 'latin1'))
    chunks.push(Buffer.from(
      `Content-Disposition: form-data; name="${part.name}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n',
      'latin1',
    ))
    chunks.push(part.bytes)
    chunks.push(Buffer.from('\r\n', 'latin1'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}\r\n`, 'latin1'))
  chunks.push(Buffer.from(
    `Content-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(envelope)}\r\n`,
    'utf8',
  ))
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'latin1'))
  return Buffer.concat(chunks)
}

// ---- 1. a plain JSON answer is returned untouched ------------------------
const plain = decodeGatewayAnswer(
  Buffer.from(JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: { accepted: true } } })),
  'application/json',
)
check(plain.ok === true && plain.value.accepted === true, 'a JSON answer decodes as before')

// ---- 2. one byte attachment is restored in place -------------------------
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x20])
const withBytes = decodeGatewayAnswer(
  multipart(
    {
      type: 'server-response',
      rpcId: 'r2',
      result: { ok: true, value: { absolutePath: '/root/x.png', bytes: png.length, content: null } },
      attachments: [{ path: ['content'], codec: 'bytes', part: 'bytes-0' }],
    },
    [{ name: 'bytes-0', bytes: png }],
  ),
  `multipart/form-data; boundary=${BOUNDARY}`,
)
check(withBytes.ok === true, 'a multipart answer decodes')
check(withBytes.value.absolutePath === '/root/x.png', 'its scalar fields survive',
  withBytes.value.absolutePath)
check(withBytes.value.content instanceof Uint8Array,
  'the byte placeholder became a Uint8Array', Object.prototype.toString.call(withBytes.value.content))
check(withBytes.value.content !== null && Buffer.compare(Buffer.from(withBytes.value.content), png) === 0,
  'and the bytes are byte-identical', withBytes.value.content?.length)

// ---- 3. a nested path is restored at the right place ---------------------
const nested = decodeGatewayAnswer(
  multipart(
    {
      type: 'server-response',
      rpcId: 'r3',
      result: { ok: true, value: { items: [{ name: 'a', data: null }, { name: 'b', data: null }] } },
      attachments: [
        { path: ['items', 0, 'data'], codec: 'bytes', part: 'bytes-0' },
        { path: ['items', 1, 'data'], codec: 'bytes', part: 'bytes-1' },
      ],
    },
    [
      { name: 'bytes-0', bytes: Buffer.from('first') },
      { name: 'bytes-1', bytes: Buffer.from('second') },
    ],
  ),
  `multipart/form-data; boundary=${BOUNDARY}`,
)
check(Buffer.from(nested.value.items[0].data).toString() === 'first', 'an array-indexed path decodes')
check(Buffer.from(nested.value.items[1].data).toString() === 'second', 'and a second attachment too')

// ---- 4. malformed input is refused, not silently misread -----------------
const rejects = (label, body, contentType) => {
  try {
    decodeGatewayAnswer(body, contentType)
    check(false, label, 'no error thrown')
  } catch {
    check(true, label)
  }
}
rejects('multipart without metadata is refused',
  Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="bytes-0"\r\n\r\nabc\r\n--${BOUNDARY}--\r\n`, 'latin1'),
  `multipart/form-data; boundary=${BOUNDARY}`)
rejects('multipart without a boundary is refused',
  Buffer.from('not multipart', 'latin1'),
  'multipart/form-data')
rejects('an attachment naming a missing part is refused',
  multipart(
    {
      type: 'server-response',
      rpcId: 'r4',
      result: { ok: true, value: { content: null } },
      attachments: [{ path: ['content'], codec: 'bytes', part: 'bytes-9' }],
    },
    [{ name: 'bytes-0', bytes: Buffer.from('x') }],
  ),
  `multipart/form-data; boundary=${BOUNDARY}`)

// ---- 5. an error answer keeps its error, not its bytes -------------------
const errored = decodeGatewayAnswer(
  Buffer.from(JSON.stringify({
    type: 'server-response',
    rpcId: 'r5',
    result: { ok: false, error: { code: 'workspace-file/not-found', message: 'no entry at "x"' } },
  })),
  'application/json',
)
check(errored.ok === false && errored.error.code === 'workspace-file/not-found',
  'a Gateway error keeps its code', errored.error?.code)

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exitCode = 0
}
