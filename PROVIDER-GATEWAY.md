# Optional provider action adapter

The application remains usable without a provider connection. The current installation has no real business backend connected. Existing connections default to read-only imports; write delivery requires explicit company-owner opt-in and a compatible gateway.

Use the existing **Company & team → Connect your service system** form. The server operator must allow the gateway origin in `PROVIDER_ALLOWED_ORIGINS`. The owner supplies the encrypted-at-rest gateway token and links each customer to their external ID. HTTPS is required in production; redirects are rejected.

## Required gateway contract

`GET /capabilities` must return:

```json
{"version":1,"idempotency":true,"actions":["request","requirement","handoff","outcome","progress"]}
```

Only advertise actions that the gateway actually implements. With write delivery enabled, Continuum sends:

`POST /customers/{externalCustomerId}/actions`

```json
{
  "actionId":"stable-local-action-id",
  "kind":"requirement",
  "customerId":"customer-42",
  "localTicketId":"local-ticket-id",
  "ticketId":"provider-ticket-id",
  "details":{"note":"Call before ordering parts."}
}
```

Every delivery has an `Idempotency-Key` header that remains stable across retries and server restarts. The gateway must atomically persist the business change and its receipt under that key. A replay must return the original receipt without repeating the change. Acknowledging idempotency in capabilities without implementing it is unsafe.

Successful responses must identify the exact action and customer:

```json
{
  "id":"provider-receipt-id",
  "status":"confirmed",
  "kind":"requirement",
  "customerId":"customer-42",
  "actionId":"stable-local-action-id",
  "ticketId":"provider-ticket-id"
}
```

For `request`, the incoming provider `ticketId` is null; the confirmed receipt supplies the created provider ID. Subsequent notes and handoffs wait for this acknowledgement. Existing read imports use `GET /customers/{externalCustomerId}/requests` and the configured field mapping.

Supported details are the validated local action fields: request title/description, requirement note, handoff summary/context, outcome, or specialist status/ETA/note. Customer IDs come from the owner's saved mapping, not model output. Gateway implementations must still verify authorization and ownership in their own database.

## Delivery behavior

Local commits and outgoing jobs are saved in one SQLite transaction. Encrypted jobs have leases, bounded backoff, stable replay keys, and visible pending/confirmed/failed status. A response for another customer or action is rejected. Configuration/mapping changes stop old jobs for review. Calendar bookings remain on their existing calendar integration and are not sent through this contract.

The integration tests use a real isolated HTTP gateway, deliberately lose an acknowledgement after saving a request, restart Continuum, and verify one remote request plus an ordered note. A second test rejects a receipt belonging to another customer. These tests validate the adapter contract; they do not constitute a live vendor integration or pilot deployment.
