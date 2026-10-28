# Changes

## 0.2.0 — 2026-10-28

Set JOB_PROCESSOR_MODULE to an absolute path of an operator-reviewed local module exporting specVersion, synchronous validate(input), async process(input), and optional async preflight(input). Preflight runs before quoting or accepting payment; the PDF processor inspects the actual PDF and requested pages here. It is application code, not a module path supplied by an untrusted request. Workers dispatch only their configured spec, only after confirmed payment. A confirmed purchase remains NOT_STARTED until claimed, then RUNNING/READY/FAILED; invalid processor results fail fulfillment. The existing text index is the default demonstration processor. For real document extraction, clone artisticsmo/kite-document-api beside this repository and point JOB_PROCESSOR_MODULE to its examples/paid-jobs-processor.mjs, install that repository's parser dependencies, and submit spec_version=pdf-extract-v1 with pdf_base64 and page_range. This executes the parser locally; it does not buy another paid service or charge twice. Use the payer-authenticated free job/result endpoints with the original Passport session.

This evaluation update retains explicit blocked real-payment, public-hosting and official-listing gates. Prior releases remain available.
