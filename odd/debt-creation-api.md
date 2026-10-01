# Debt creation retry contract

POST /deudas accepts an optional client-generated UUID in id. Legacy requests without id still receive a server-generated UUID and are not retry-safe.

Keep the ID and creation payload unchanged until synchronization is confirmed. A matching retry returns the original JSON creation result (HTTP 201, preserving this endpoint's existing response shape/status), even after subsequent payments, stock changes or schedule edits. Reusing the ID with different input returns HTTP 409.

The immutable SHA-256 fingerprint includes the authenticated account, tenant, member/device selection, debt type, product/quantity, existing or inline debtor, initial payment and ordered installment schedule. No authentication token is stored. Replays revalidate the active account, socio membership and authorized device inside the transaction.

Creation, stock decrement, inline debtor, initial payment, schedule and the original response snapshot commit together. Concurrent retries reread a committed winner after debt-ID uniqueness or business-validation failure; losing writes roll back. Historical debts have no receipt and cannot be replayed.

Insufficient stock without a matching committed creation remains HTTP 400. The future offline client must retain this definitive rejection as needs_review, not silently discard it. Different tenant ID collisions return a generic HTTP 409 and never expose another tenant's result or database details.

Apply the additive migration before deploying this API version. Migration application is a separate authorized operation; no historical receipt backfill is possible.

Later payments against an existing debt intentionally remain connection-required. They need their own retry identity and balance-conflict policy; initial payments are already part of this creation transaction.
