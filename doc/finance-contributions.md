# Capital contributions API

A contribution records money delivered to the business. It is not a sale, profit, ownership, salary, commission, an automatic repayment obligation or withdrawable money. Contributions never enter sales or profit reports.

## Create and browse

All endpoints require bearer authentication, an authorized device and an active selected socio (`SocioGuard`). Contributors must be active socios in the same business; contributor and recorder are independent. The server derives business and account from authentication.

`POST /api/v1/finance/contributions`:

```json
{
  "id": "0199aae0-1000-7000-8000-000000000001",
  "memberId": "0199aae0-1000-7000-8000-000000000002",
  "createdByMemberId": "0199aae0-1000-7000-8000-000000000003",
  "deviceId": "0199aae0-1000-7000-8000-000000000004",
  "amountMinor": 800000,
  "occurredAt": "2026-10-03T00:00:00-06:00",
  "note": "Initial capital"
}
```

Money is positive integer MXN cents, at most 2147483647. IDs owned by the client must be UUID v7. Instants require explicit timezone and at most three fractional-second digits. Notes are optional, at most 1000 characters; omitted/null normalize to null, whitespace is preserved.

201 returns the fields above plus `contextId`, `currency: "MXN"`, `createdByAccountId` and `receivedAt`, with instants normalized to UTC. Exact replay returns 200 and the immutable original receipt. Same UUID with different normalized content or authenticated account returns 409. Origin IDs must match request headers (403 otherwise). No credentials are persisted in contributions.

`GET /api/v1/finance/contributions?from=<instant>&to=<instant>&memberId=<uuid>&limit=20&cursor=<opaque>` returns `{ "items": [...], "nextCursor": null }`. Filters are optional; `from` inclusive, `to` exclusive, based on economic `occurredAt`, not reception. Descending `(occurredAt,id)` cursor pagination, limit 1–100; invalid/reversed ranges and malformed cursors return 400. Items include `member: {id,name,active}`; private fingerprint/receipt fields are not exposed. Historical references are retained.

## Offline integration

Persist the UUID and unchanged payload locally before success. Preserve account/API/member/device origin separately, without tokens. Replay with the original origin; never reattribute under a new session. Reconcile pending and confirmed records by UUID. Financial queues do not reuse sales operations.

## Deployment boundary

Additive migration, Prisma tenant extension and forced deny-by-default RLS scope Contribution. Local verification uses only isolated `bazar_test`; production migration application is not part of this change.
