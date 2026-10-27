# Changelog

All notable changes to `@espresso-notify/node` are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the library follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-27

### Added

- `EspressoNotify`, a client with the 14 server operations of the `/v1` API as typed methods: notifications (broadcast, personalized, transactional, batch, get, cancel), users, tokens, conversions, journeys, preferences, categories and variables. `ea6c54986`
- A call retries on 408, 429, 500, 502, 503 and 504 and on connection failures and timeouts, with full-jitter back-off and `Retry-After`, and fails with a typed `EspressoNotifyApiError`; `AbortSignal` and a timeout per attempt are supported. `8e3078b1c`
- A send without an `idempotency_key` gets one that stays the same on every retry of the call, so a retried send is never delivered twice. `7e96fbcd6`
- `verifySignature` checks the HMAC and Ed25519 signatures of webhooks, journey webhooks and event streams over the raw body, with a time tolerance and secret rotation. `f4b52bb02`
- The client refuses a public key and a browser, and the types of the answers for the variables and categories routes are generated from the API contract. `ea6c54986`, `e33ea0378`
- The `fetch` option sends every request of the client through a function of yours (a proxy, an undici dispatcher), with the same headers and body; the README shows the `ProxyAgent` recipe and the `NODE_USE_ENV_PROXY=1` route. `c2079334d`
- The `deadlineMs` option (default 60000, on the client and on each call) bounds a whole call, retries and waits included, and a call that reaches it rejects with `deadline_exceeded`. `032e9e45b`
- `preferences.set` and `preferences.query` name the user by `external_id` alone, the preferences apply to every device of that user, and the `push_token` is optional. `b89a08721`

### Changed

- The library needs Node.js 22 or newer. `2bab274f2`
- A `Retry-After` wait is stretched by a random 0 to 25% (never past 60 seconds), so callers refused together do not return together. `032e9e45b`
- Only an operation that is safe to repeat is retried: `journeys.enter` makes one attempt unless the call passes `maxRetries`, and the sends (by their idempotency key), the reads, `notifications.cancel`, `users.create`, `tokens.add`, `conversions.record` and `preferences.set` keep their retries. `87c562af6`
- A 2xx answer that is not JSON rejects with `invalid_response`, a signed body that is not JSON with `invalid_body`, an id that is empty, `.` or `..` with `invalid_argument` and a public key that is not Ed25519 with `invalid_verification_key`, so every failure is an error of the library. `130c68688`

### Security

- A release is published from the public repository with an npm provenance statement, and the job that runs the tests never holds the permission to sign: only the job that stages the tested build does. `f1133a6ef`, `ef5ac2d1f`
- The API key is checked whole (`invalid_api_key` for a space, a line break or any character a key is not made of) and never kept in an error or a cause. `5ce3d8434`
- A redirect is never followed (it rejects with `unexpected_redirect`) and `baseUrl` must be `https` except for `localhost`, `127.0.0.1` and `[::1]`, so the key and the body never leave for another host. `46bae0acf`
- `maxRetries`, `timeoutMs`, `deadlineMs`, `toleranceSeconds` and `now` are validated and refused with `invalid_option` when they are `NaN`, infinite or of the wrong type, so a bad tolerance no longer accepts a replay. `e4df3210a`
- `verifySignature` refuses an empty or blank secret or public key, alone or inside a list, because a signature made with an empty key can be forged by anyone. `3712ced80`
