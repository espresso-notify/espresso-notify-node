import { randomUUID } from "node:crypto";

type Keyed = { idempotency_key?: string };

/**
 * A send that carries no `idempotency_key` gets a random UUID v4, made once for the call. The body with the key is what every
 * attempt of the call sends, so a send that was accepted and whose answer was lost is never delivered twice by a retry. A key
 * the caller chose is sent as it is. The caller's object is not changed.
 */
export function withIdempotencyKey<T extends Keyed>(body: T): T {
  return body.idempotency_key === undefined ? { ...body, idempotency_key: randomUUID() } : body;
}

/** The same for a batch: the key is per item, because the batch itself has none. Items that carry a key keep it. */
export function withIdempotencyKeys<T extends { items: Keyed[] }>(body: T): T {
  return { ...body, items: body.items.map(withIdempotencyKey) };
}
