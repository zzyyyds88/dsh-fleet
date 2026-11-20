/**
 * The brain's runtime glue: print the entry URL, provide `webApp`, mount nothing.
 *
 * Upstream's `web-runtime` row (`@deepseek-ai/dsh-web-app`) does four things: it
 * mounts the built SPA dist through `frontend-static`, registers `DSH_WEB_URL`,
 * prints the tokenized entry URL, and hands that URL to a desktop browser. A brain
 * wants the middle two and neither of the ends: there is no dist on a node to serve,
 * and no browser on it to open.
 *
 * That is the whole reason this package exists. Everything else a brain needs comes
 * verbatim from `@deepseek-ai/dsh-web-app`'s patch, which
 * `scripts/sync-from-upstream.mjs` copies.
 *
 * @module @local/rnh-brain/runtime
 */

/** Stable Cordis plugin name. */
export const name = 'brain-runtime'

/**
 * Services this row reads.
 *
 * Cordis requires every service a plugin touches to be declared here — reading
 * `ctx.webServer` without it throws `cannot get property "webServer" without inject`,
 * and because that happens inside a promise chain the only visible symptom is a Host
 * that boots, listens, and prints nothing. `webStartup` carries the parsed
 * `dsh --profile <p>` flags; `webServer` is the listener this row advertises;
 * `connection` owns the launch token (see `ctx.inject` below for why it is optional).
 */
export const inject = ['webStartup', 'webServer']

/** The advertised application surface this Host serves. */
export const WEB_APP_SERVICE = 'webApp'

/**
 * Exchange a launch token for a browser cookie, with no SPA behind it.
 *
 * In the shipped Web composition this is `frontend-static`'s fallback seat: the
 * browser hits `/?token=…`, the fallback calls `connection.authorizeIndex`, which
 * mints the session cookie and answers `303 → ./`; everything else is the dist.
 *
 * A brain has no dist, but it does need the exchange — the plugin and
 * `ds-harness-remote` both speak cookie-authenticated `/api`, and the launch URL is
 * where that cookie comes from. Without this seat, `/?token=…` falls through to no
 * fallback at all and the webserver answers **404**, which looks like "the node has
 * no Remote API" while the API itself is fine.
 *
 * So the seat is claimed with only the authentication half: index requests behave
 * exactly as in the Web composition, and every other unmatched path is 404.
 * @param {import('@deepseek-ai/cordis').Context} ctx - a context carrying `webServer` and `connection`.
 */
function claimIndexSeat(ctx) {
  /**
   * Run `connection.authorizeIndex` against a WHATWG request.
   *
   * `authorizeIndex` speaks the node:http shape (`req.url`, `req.method`,
   * `req.headers`) and writes through a `res`-like object. A `Request` already has
   * the first three, and this adapter captures the writes.
   * @param {Request} request
   * @returns {Response | undefined} the response to send instead of the document.
   */
  const authorize = request => {
    let status = 401
    let headers = new Headers()
    /** @type {string | undefined} */
    let body
    const handled = ctx.connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = new Headers(nextHeaders)
      },
      end(text) {
        body = text
      },
    })
    if (handled) return undefined
    return new Response(body ?? null, { status, headers })
  }

  ctx.effect(() => ctx.webServer.registerFallback({
    resource: (request) => {
      // Only the entry path belongs to the cookie exchange; anything else is a
      // browser asset this node does not have.
      const path = new URL(request.url).pathname
      if (path !== '/' && path !== '/index.html') return Promise.resolve(new Response(null, { status: 404 }))
      const denied = authorize(request)
      if (denied !== undefined) return Promise.resolve(denied)
      // The token was accepted and the cookie is set; there is no page to render.
      return Promise.resolve(new Response(
        'the brain serves the Remote API only; there is no browser UI here\n',
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      ))
    },
  }), 'brain-runtime: index seat')
}

/**
 * Mount the brain runtime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {{ printUrl?: boolean }} [config] - resolved row config.
 */
export function apply(ctx, config) {
  const printUrl = config?.printUrl !== false
  // The advertised root: `--public-url` when given, otherwise the listener's origin.
  const appRootUrl = () => ctx.webStartup.publicUrl ?? ctx.webServer.getOrigin()

  // `webApp.getAdvertisedUrl()` is the Host's own answer to "where is this served
  // from". A brain has no GUI, but the service is part of the Host contract — other
  // rows and Remote callers read it — so it is provided rather than omitted.
  ctx.provide(WEB_APP_SERVICE, { getAdvertisedUrl: appRootUrl })

  // The cookie exchange lives on the fallback seat, which nothing else claims on a
  // brain (no dist server is composed), and the launch token lives on `connection`.
  // One injection covers both: a brain composed without `connection` still serves
  // the API to a caller that supplies its own credentials, instead of failing the
  // whole composition at load time.
  ctx.inject(['connection'], connectionCtx => {
    claimIndexSeat(connectionCtx)

    if (!printUrl) return
    const announce = () => {
      console.log(`dsh web: ${connectionCtx.connection.authenticatedUrl(appRootUrl())}`)
    }
    // Print after the Loader settles so the line describes a fully composed Host.
    // The publication is what the desktop app and this plugin's daemon both parse.
    const settled = connectionCtx.get('loader')?.await()
    if (settled === undefined) {
      announce()
      return
    }
    connectionCtx.effect(() => {
      let live = true
      void settled.then(() => {
        if (live) announce()
      }).catch(() => {
        // The Loader owns startup diagnostics; a failed composition prints nothing
        // here and the launcher reports why.
      })
      return () => { live = false }
    }, 'brain-runtime: announce entry URL')
  })
}
