#!/usr/bin/env node
/**
 * Put the plugin tarball on CNB, where users and the phone actually download it from.
 *
 * **Why this exists as a separate script from `publish-runtime.mjs`.** The two publish
 * different objects to different releases: `publish-runtime.mjs` publishes the *node runtime*
 * (`dsh-<dshVersion>-<platform>.tar.gz`, tagged `v<dshVersion>`), this one publishes the
 * *plugin* (`greatbaby-dsh-remote-node-harness-<version>.tgz`, tagged `v<version>`). They are
 * separate version lines — the plugin release changes when this repository changes, the
 * runtime release changes when DSH does — so folding them into one script would mean one
 * script knowing two tag schemes and two asset naming rules.
 *
 * The four API calls are the same contract `publish-runtime.mjs` documents at length, and the
 * fourth is the one that is easy to miss:
 *
 *   1. `POST /{repo}/-/releases` — 409 means "already there", which is the normal re-publish;
 *   2. `POST /{repo}/-/releases/{id}/asset-upload-url` — signed URL plus a `verify_url`;
 *   3. `PUT` the bytes;
 *   4. `POST` the `verify_url`. **Without this the asset never becomes part of the release:**
 *      the PUT answers 200, the asset list stays empty, and an anonymous download 404s.
 *
 * Usage:
 *   CNB_TOKEN=… node scripts/upload-plugin.mjs --version 0.6.0 --file dist/plugin/*.tgz
 *
 * `CNB_TOKEN` is read from the environment and never written anywhere: this repository is
 * public. The repository itself must be public too — the node holds no CNB credential.
 */
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const version = value('version')
const file = value('file')
const repository = value('cnb-repo', 'serendipity-archive/dsh-fleet')

if (typeof version !== 'string' || version === '') {
  throw new Error('--version is required, e.g. --version 0.6.0')
}
if (typeof file !== 'string' || file === '') {
  throw new Error('--file is required, e.g. --file dist/plugin/greatbaby-dsh-remote-node-harness-0.6.0.tgz')
}
const token = process.env.CNB_TOKEN
if (typeof token !== 'string' || token === '') {
  throw new Error('CNB_TOKEN must be in the environment; it is never written to disk')
}

const path = resolve(file)
const bytes = readFileSync(path)
const name = basename(path)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const tag = `v${version}`

const base = `https://api.cnb.cool/${repository}`
// CNB answers `406 … only supports returning 'application/json' or
// 'application/vnd.cnb.api+json'` when the Accept header is anything else, which reads like a
// body problem rather than a header one.
const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.cnb.api+json' }
const json = { ...headers, 'content-type': 'application/json' }

const notes = [
  `DeepSeek Harness remote node plugin, version ${version}.`,
  '',
  'Install it on the desktop with:',
  '',
  '```',
  `dsh plugin --profile <profile> add -w https://cnb.cool/${repository}/-/releases/download/${tag}/${name}`,
  '```',
  '',
  'The node side needs no plugin: a node runs the DSH runtime archive published under the',
  'matching `v<dshVersion>` release, and the brain bundle travels inside this tarball.',
  '',
  `sha256 \`${sha256}\``,
].join('\n')

const created = await fetch(`${base}/-/releases`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({
    tag_name: tag,
    name: `Plugin ${version}`,
    body: notes,
    // `target_commitish` is mandatory here (400 without it) even though the tag already exists.
    target_commitish: 'main',
  }),
})
if (!created.ok && created.status !== 409) {
  throw new Error(`CNB release ${tag}: ${created.status} ${(await created.text()).slice(0, 300)}`)
}

const release = await fetch(`${base}/-/releases/tags/${encodeURIComponent(tag)}`, { headers })
if (!release.ok) throw new Error(`CNB release ${tag} is not readable: ${release.status}`)
const { id } = await release.json()

const granted = await fetch(`${base}/-/releases/${id}/asset-upload-url`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ asset_name: name, overwrite: true, size: bytes.length, ttl: 0 }),
})
if (!granted.ok) {
  throw new Error(`CNB upload URL for ${name}: ${granted.status} ${(await granted.text()).slice(0, 300)}`)
}
const { upload_url: uploadUrl, verify_url: verifyUrl } = await granted.json()

const put = await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
  body: bytes,
})
if (!put.ok) throw new Error(`CNB upload of ${name}: ${put.status} ${(await put.text()).slice(0, 300)}`)

const confirmed = await fetch(verifyUrl, { method: 'POST', headers })
if (!confirmed.ok) {
  throw new Error(`CNB confirmation of ${name}: ${confirmed.status} ${(await confirmed.text()).slice(0, 300)}`)
}

// Read the asset back rather than trusting the PUT: the release's list carries the hash CNB
// computed, so this is a check of the published bytes, not of our own intention.
const settled = await (await fetch(`${base}/-/releases/tags/${encodeURIComponent(tag)}`, { headers })).json()
const asset = (settled.assets ?? []).find(item => item.name === name)
if (asset === undefined) throw new Error(`CNB accepted the upload but ${name} is not in release ${tag}`)
if (asset.hash_value !== sha256) {
  throw new Error(`CNB reports sha256 ${asset.hash_value} for ${name}; the file is ${sha256}`)
}

// The release body changes when the version does, and a re-publish of the same version has to
// rewrite it or the release keeps describing whatever the first upload said.
const patched = await fetch(`${base}/-/releases/${id}`, {
  method: 'PATCH',
  headers: json,
  body: JSON.stringify({ body: notes }),
})
if (!patched.ok) process.stdout.write(`  could not update the release body: ${patched.status}\n`)

process.stdout.write(
  `published ${name} to CNB ${tag}\n`
  + `  ${asset.browser_download_url}\n`
  + `  sha256 ${sha256}\n`,
)
