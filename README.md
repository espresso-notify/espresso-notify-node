# @espresso-notify/node

The Node.js server library for the [Espresso Notify](https://espressonotify.com) `/v1` API. It gives your backend typed methods for the server operations, retries a transient failure without ever sending twice, raises typed errors, and verifies the signature of the webhooks, journey webhooks and event streams that Espresso Notify sends to you.

## Install

```bash
npm install @espresso-notify/node
pnpm add @espresso-notify/node
yarn add @espresso-notify/node
bun add @espresso-notify/node
```

The package has no runtime dependency and runs no install script, so there is nothing to allow in the `onlyBuiltDependencies` of pnpm or in the trusted dependencies of Bun. It ships ESM and CommonJS with types, and needs Node.js 22 or newer. Each version is published from this repository with an npm provenance statement.

- Zero runtime dependencies. ESM and CommonJS builds with type declarations.
- Node.js 22 or newer (tested on 22 and 24).
- For a server only: the library holds a secret key (`sk_live_`) and refuses to run in a browser. A public key (`pk_`) belongs in the app SDKs and is refused. The key is checked whole: one with a space, a line break or any character a key is not made of is refused at construction (`invalid_api_key`), and no error of the library ever holds the key.

## Use

```ts
import { EspressoNotify } from '@espresso-notify/node'

const client = new EspressoNotify({ apiKey: process.env.ESPRESSO_SECRET_KEY! }) // sk_live_...

const answer = await client.notifications.transactional({
  to: { external_id: 'user-1001' },
  title: 'Your order is on its way',
  body: 'Track it in the app.',
  idempotency_key: 'order-1042-shipped', // optional: the library makes one when you leave it out
})
```

The 14 methods are grouped as `notifications` (`broadcast`, `personalized`, `transactional`, `transactionalBatch`, `get`, `cancel`), `users.create`, `tokens.add`, `conversions.record`, `journeys.enter`, `preferences` (`set`, `query`: the user is named by `external_id` alone, and the preferences apply to every device of that user; a `push_token` is optional), `categories.list` and `variables.list`. Every method takes an optional last argument, `{ signal, timeoutMs, maxRetries, deadlineMs }`, for that one call.

- **Retries:** only an operation that is safe to repeat is retried, because a retry follows an answer that may have been lost after the work was done. The sends (the `idempotency_key` collapses a repeat), the reads (`notifications.get`, `preferences.query`, `categories.list`, `variables.list`), `notifications.cancel` (a second cancel answers `already_cancelled`), `users.create` and `tokens.add` (both are upserts), `conversions.record` (a repeated `external_txn_id` is ignored) and `preferences.set` (it sets the values it is given) are. `journeys.enter` is not: with the default re-entry rule of a journey a repeat starts a second run, so it makes one attempt whatever the client's `maxRetries`, and is retried only when the call itself passes `maxRetries` (when you know the journey is set to enter once). For the operations that are retried, 408, 429, 500, 502, 503 and 504, and connection failures and timeouts, are retried up to `maxRetries` times (default 2) with full-jitter back-off (the first wait is 0 to 500 ms, then up to 1 s, doubling to a cap of 8 s); a `Retry-After` wins, up to 60 seconds, plus a random 0 to 25% so callers refused together do not return together (never more than 60 seconds in all).
- **Deadline:** `deadlineMs` (default 60000, on the client and on each call) bounds a whole call, the retries and the waits between them included. A call that reaches it rejects with `EspressoNotifyApiError` `deadline_exceeded` (`status` 0, `cause` the last failure), and a wait that does not fit in the time left ends the call at once. `timeoutMs` above `deadlineMs` is cut to it, so raise both together. A send without an `idempotency_key` gets one, kept across the retries of the call.
- **Errors:** `EspressoNotifyApiError` (`status`, `code`, `error`, `requestId`, `retryAfterSeconds`; `status` 0 and `code` `network_error` when no answer arrived; `request_not_sent` when `fetch` refused the request before it left, which is not retried), `EspressoNotifyAbortError`, `EspressoNotifyConfigError` and `EspressoNotifySignatureError`.
- **Bad answers and bad input:** every failure is a library error. A 2xx answer that is not JSON rejects with `EspressoNotifyApiError` `invalid_response` (with the `status` and `requestId`, never the text, and without a retry). An id that is empty, blank, `.` or `..` is refused with `EspressoNotifyConfigError` `invalid_argument` before anything is sent (`notifications.get`, `notifications.cancel`, `journeys.enter`). `verifySignature` throws `EspressoNotifySignatureError` `invalid_body` for a validly signed body that is not JSON and `missing_header` when the headers are `null` or not an object (a header value that is not a string counts as absent), and `EspressoNotifyConfigError` `invalid_verification_key` for a `publicKey` that is not Ed25519.
- **Options:** `maxRetries` is a whole number from 0 to 10 and `timeoutMs` and `deadlineMs` a number above 0 up to 2147483647, on the client and on each call; `toleranceSeconds` and `now` of `verifySignature` must be a finite non-negative number and a function that returns one. Anything else (`NaN`, `Infinity`, a string) is refused with `EspressoNotifyConfigError` `invalid_option` naming the option, instead of turning a limit off.
- **Transport:** `baseUrl` must be an `https` URL (plain `http` only for `localhost`, `127.0.0.1` and `[::1]`), else `invalid_base_url`. A redirect from the API is never followed: it rejects with `unexpected_redirect` and is not retried.
- **Your own fetch (proxy, dispatcher):** the `fetch` option takes a function with the signature of the global `fetch` and sends every request of every operation, retries included, with the headers and body the global one would send. Behind a proxy, give it undici's `ProxyAgent` (`npm install undici`):

  ```ts
  import { ProxyAgent, fetch as undiciFetch } from 'undici'

  const dispatcher = new ProxyAgent(process.env.HTTPS_PROXY!)
  const client = new EspressoNotify({
    apiKey: process.env.ESPRESSO_SECRET_KEY!,
    // undici ships its own fetch types, so a cast tells TypeScript they are the same thing
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher } as never) as unknown as Promise<Response>,
  })
  ```

  Without a code change, start Node with `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` (and `NO_PROXY`) set and the global `fetch` follows them (checked on Node 22.23 and 24.3; an older 22.x may not have it, use the option). A function that returns something that is not a `Response` rejects with `invalid_response`; an error it throws is treated like one of the global `fetch` (a connection failure is retried, a refused request is `request_not_sent`).
- **Test without sending:** add `dry_run: true`. There is no test key; only `sk_live_` keys exist.

### Verify a signed request

```ts
import { verifySignature } from '@espresso-notify/node'

// body: the raw bytes of the request, before any JSON.parse
const event = verifySignature({ body, headers, secret: process.env.ESPRESSO_WEBHOOK_SECRET! })
```

It throws `EspressoNotifySignatureError` (`signature_mismatch`, `timestamp_out_of_tolerance`, `missing_header` or `raw_body_required`) when the request must not be trusted, and refuses an empty secret or key.

## Documentation

The guide, with the examples compiled against this source, is at https://docs.espressonotify.com/docs/server-libraries/node.

- Framework recipes (Express, Fastify, NestJS, Next.js): https://docs.espressonotify.com/docs/server-libraries/node-recipes
- Reference of every method, error and option: https://docs.espressonotify.com/docs/server-libraries/node-reference
- Moving from direct `fetch` calls to the library: https://docs.espressonotify.com/docs/server-libraries/node-migrate

## Where the code comes from

`src/generated/` is generated from `docs-site/public/openapi/v1.yaml` of the Espresso Notify repository by a pinned `openapi-generator`; the hand-written layer is the rest of `src/`. The tests read the requests and the answers from `fixtures/`, which the API's own tests write from its real routes.

## License

Apache-2.0. See [LICENSE](LICENSE).
