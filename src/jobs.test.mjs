import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "./store.mjs";
import { Jobs, pollJob, textIndex } from "./jobs.mjs";
const input = {
  operation_id: "job-purchase",
  spec_version: "text-index-v1",
  documents: [
    {
      id: "a",
      text: "Kite agents buy useful APIs. Kite APIs deliver results.",
    },
  ],
};
async function setup(t, options = {}) {
  const d = mkdtempSync(join(tmpdir(), "jobs-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const vault = new Vault(d, randomBytes(32).toString("hex")),
    jobs = new Jobs(vault, options);
  let id;
  await vault.transaction((s, save) => {
    id = jobs.prepare(input, "buyer", s).job_id;
    s.payments = { [input.operation_id]: { payment_state: "UNKNOWN" } };
    save();
  });
  return { vault, jobs, id };
}
test("unresolved payment cannot dispatch; confirmed outbox survives recovery", async (t) => {
  const c = await setup(t);
  assert.equal(await c.jobs.tick(), false);
  await c.vault.transaction((s, save) => {
    s.payments[input.operation_id].payment_state = "CONFIRMED";
    save();
  });
  const restarted = new Jobs(c.vault);
  assert.equal(await restarted.tick(), true);
  const result = await restarted.get(c.id, "buyer", true);
  assert.equal(result.status, "SUCCEEDED");
  assert(result.result.total_words > 0);
  assert.equal(await restarted.tick(), false);
  await assert.rejects(restarted.get(c.id, "other", true), {
    code: "job_not_found",
  });
});
test("worker failure preserves confirmed payment and marks paid unfulfilled", async (t) => {
  const c = await setup(t, {
    processor: async () => {
      throw Error("worker fail");
    },
  });
  await c.vault.transaction((s, save) => {
    s.payments[input.operation_id].payment_state = "CONFIRMED";
    save();
  });
  await c.jobs.tick();
  const r = await c.jobs.get(c.id, "buyer");
  assert.equal(r.status, "FAILED");
  assert.equal(r.payment_state, "CONFIRMED");
  assert.equal(r.issue, "paid_unfulfilled_manual_review");
});
test("expired artifact inaccessible without deleting payment evidence", async (t) => {
  const c = await setup(t, { retentionMs: -1 });
  await c.vault.transaction((s, save) => {
    s.payments[input.operation_id].payment_state = "CONFIRMED";
    save();
  });
  await c.jobs.tick();
  await assert.rejects(c.jobs.get(c.id, "buyer", true), {
    code: "artifact_expired",
  });
  assert.equal(
    c.vault.read().payments[input.operation_id].payment_state,
    "CONFIRMED",
  );
});
test("poll origin includes scheme and port; timeout is unresolved without repurchase", async () => {
  for (const url of [
    "https://other.example/job",
    "http://seller.example/job",
    "https://seller.example:444/job",
    "//evil.example/job",
  ])
    await assert.rejects(
      pollJob({ merchantUrl: "https://seller.example/v1/jobs", pollUrl: url }),
      { code: "cross_origin_poll_rejected" },
    );
  let calls = 0;
  const r = await pollJob({
    merchantUrl: "https://seller.example/v1/jobs",
    pollUrl: "/v1/jobs/one",
    session: "original",
    attempts: 2,
    wait: async () => {},
    request: async (args) => {
      assert.equal(args.session, "original");
      calls++;
      return { status: "RUNNING", input_url: "https://example.com" };
    },
  });
  assert.equal(r.status, "unresolved");
  assert.equal(r.repurchase, false);
  assert.equal(calls, 2);
});
test("bounded job rejects duplicate document IDs and computes actual index", () => {
  assert.equal(textIndex(input).documents[0].top_terms[0].term, "apis");
  assert.throws(() =>
    textIndex({
      ...input,
      documents: [input.documents[0], input.documents[0]],
    }),
  );
});
test("completed poll follows authenticated same-origin artifact with original session", async () => {
  const calls = [];
  const r = await pollJob({
    merchantUrl: "https://seller.example/v1/jobs",
    pollUrl: "/v1/jobs/job-one",
    session: "original-session",
    request: async (args) => {
      calls.push(args);
      return args.url.endsWith("/result")
        ? { status: "SUCCEEDED", result: { words: 12 } }
        : {
            status: "SUCCEEDED",
            result: { artifact_url: "/v1/jobs/job-one/result" },
          };
    },
  });
  assert.equal(r.result.words, 12);
  assert.equal(calls.length, 2);
  assert(calls.every((c) => c.session === "original-session"));
});
