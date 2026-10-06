# Record business work without assigning compensation

Work shifts are immutable work facts. They do not affect money, ownership, inventory, sales, pay, distributions or reserves. Worker and recorder may be different members.

## Quick path

Use the existing authenticated business login, selected member and authorized device headers (and device token when activated). Production routes have the global prefix `/api/v1`; test routes omit it.

1. A socio posts `/api/v1/finance/work-shifts` with the payload below.
2. Keep the returned immutable receipt. Retry the same UUID and normalized content to get that receipt with HTTP 200; first creation is 201 and changed content/account is 409.
3. Read the list or summary. Collaborators see only their own work; socios see the business.

```json
{
  "id": "0199b14c-0000-7000-8000-000000000001",
  "memberId": "<worker UUID>",
  "workDate": "2026-10-05",
  "minutes": null,
  "note": "Stock sorting",
  "createdByMemberId": "<selected socio UUID>",
  "deviceId": "<selected device UUID>"
}
```

`id` is a client UUIDv7. `memberId` names an active worker of either role in this business. `createdByMemberId` and `deviceId` MUST match the validated headers. Context/account are server-derived and cannot be supplied. Omitted/null minutes mean unknown; known minutes are positive integers up to 2147483647 with no daily cap. Note is optional/null, at most 1000 characters, preserved verbatim. Work date is a strict valid YYYY-MM-DD calendar date, not an instant.

The receipt contains those normalized fields plus `contextId`, `createdByAccountId`, zoned `receivedAt` and `warnings`. Multiple active records per worker/day are allowed. A later same-day receipt warns with `{ code: "MULTIPLE_SHIFTS_SAME_DAY", existingActiveShiftCount: N }`; its warning never changes on replay. Worker deactivation does not invalidate history or exact retries by an authorized recorder.

## Read contract

| Route | Query | Response |
|---|---|---|
| GET work-shifts | from/to, memberId, duration, status, limit, cursor | `{ items, nextCursor }` |
| GET work-shifts/summary | from/to, memberId, duration | `{ totals, members }` |

`from` is inclusive; `to` exclusive, date-only, and from must precede to. `duration=known|unknown`; `status=active|reversed`, omitted for both. List limit defaults to 20, max 100. Opaque validated keyset cursor orders descending workDate/id; reuse the same filters while paging. Each item includes worker metadata, audit attribution, optional reversal and `replacedByReversal` trace. No fingerprint or internal stored receipt is returned.

Summary includes active records only. Totals and each member group contain `shiftCount`, `knownMinutes` and `unknownDurationCount`. Count records, NOT distinct days. Known minutes exclude unknown durations and must not be presented as complete measured time. Each group additionally has `memberId` and `member` metadata. A collaborator's explicit other-member filter is 403 on both reads.

## Auditable correction

Only a socio may POST `/api/v1/finance/work-shifts/:id/reversals`. The original is never edited or deleted. Send a new UUIDv7, nonblank `reason` (max 1000), explicitly zoned `occurredAt` (max three fractional-second digits), `createdByMemberId`, `deviceId`, and optionally `replacement` with the full creation payload above. All correction identities must differ. Omit replacement for a reversal without replacement.

```json
{
  "id": "0199b14c-0000-7000-8000-000000000002",
  "reason": "Correct recorded duration",
  "occurredAt": "2026-10-05T12:00:00-06:00",
  "createdByMemberId": "<selected socio UUID>",
  "deviceId": "<selected device UUID>",
  "replacement": {
    "id": "0199b14c-0000-7000-8000-000000000003",
    "memberId": "<worker UUID>",
    "workDate": "2026-10-05",
    "minutes": 90,
    "createdByMemberId": "<selected socio UUID>",
    "deviceId": "<selected device UUID>"
  }
}
```

First correction returns 201; identical normalized retries/account return the immutable receipt with 200. Changed content/account, an already reversed original, or a used identity returns 409; unknown/foreign originals return the same 404. An unauthorized/inactive/foreign replacement worker returns 403, atomically leaving no reversal or replacement behind.

Receipt contains reversal `id`, `workShiftId`, nullable `replacementWorkShiftId`, reason/audit attribution, server context/account/receivedAt, `original` creation receipt and nullable `replacement` creation receipt. Original receipts replay unchanged even after reversal. A replacement is a new immutable shift and can itself be reversed, creating a traceable correction chain. Replaying a replacement by the direct create endpoint is not the correction retry contract: retry the reversal payload instead.

Original and replacement days share the same deterministic lock ordering with recording. Replacement warnings exclude the corrected original; other active shifts on that worker/day still count. Original/replacement insertion and reversal commit together, never partially.

## Integrity and delivery

Identity locks precede sorted tenant/worker/day locks. Transactional recorder/device/worker share locks prevent authorization changes during writes. Database checks, restrictive composite tenant foreign keys, and deny-by-default ENABLE/FORCE RLS protect both new tables. No PATCH/DELETE correction is exposed.

Local feature-branch-chain work only; no PR, push or deployment is authorized. Recording/list/summary and correction are coherent future slices; actual over-budget slices require maintainer approval before PR creation. Regression suites run against isolated localhost:5433/bazar_test only.
