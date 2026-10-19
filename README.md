# Paid Jobs

Durable paid job fulfillment and wallet-authenticated free retrieval.

Version 0.1.0 is an AI-assisted engineering evaluation release, developed under one operator and assigned to this GitHub account. It is not evidence of independent human adoption, official Kite approval, Electric Capital inclusion or successful live payment.

## Run and verify

Node.js 20.11+ is required.

```sh
npm ci
npm test
# Configure the environment described below, then:
npm start
```

The fixed-price text-index-v1 task accepts at most 20 unique documents, 50,000 characters each and 200,000 total. It produces a deterministic per-document index, top terms, word counts and hashes. POST /v1/jobs first persists the accepted job/outbox before settlement. The worker only leases jobs whose original purchase is CONFIRMED. A crash-safe lease and a three-attempt bound recover deterministic work without buying again.

GET /v1/jobs/{id} and /v1/jobs/{id}/result authenticate the original verified payer using the official x402 SIWX extension library. They advertise accepts=[] and require no monetary payment. Replay nonces bind the exact retrieval URI. EOA cryptographic verification is locally tested; KITE_RPC_URL enables smart-wallet verification through viem. Passport session interoperability remains unverified.

Task status, payment and artifact availability are distinct. Unknown settlement never dispatches. Worker failure creates paid_unfulfilled_manual_review, not a fabricated refund. Result retention is 24 hours; transaction/audit references survive expiration. pollJob resolves and enforces exact origin, bounded backoff and unresolved timeout without repurchase.

## Configuration and recovery

Use .env.example as a list of required environment variables; the service does not automatically load it. Generate a fresh 32-byte hex DATA_KEY locally, keep it outside the repository and retain it across restarts. Supply strong operator/application bearer tokens and a real receiver and asset before enabling a service. Values are intentionally blank so example configuration cannot silently charge a wrong wallet. The stored payment state UNKNOWN never means unpaid. Inspect the original receipt/activity and restricted journal; do not change an operation key to buy again. Where a writer lock survives a crash, stop all writer processes and review the journal before removing only the stale lock directory.

## Integration evidence

Read [compatibility.json](compatibility.json) and [the protocol boundary](docs/PROTOCOL.md). Local tests are E1; read-only public capability/RPC observations prove only the facts observed. Real Passport approval, funded purchase, SIWX interoperability, public deployment and catalog/EC review are not completed by this release. The service manifest stays draft and uses placeholder pay_to until a genuine receiver and deployment are configured.

## Scope and evidence

[Original PRD](docs/PRD.md) describes the full target, not a claim that every external acceptance gate has passed. [Event contract](docs/EVENTS.md) defines the application records. The standalone repositories share protocol/storage support code, with distinct business implementations and tests. The license is MIT; third-party dependencies keep their upstream licenses. Reproduce failures without publishing payment signatures, account credentials or private files.
