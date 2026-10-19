import { randomUUID } from "node:crypto";
import { fault, hash, audit } from "./store.mjs";
export function checkJob(input) {
  if (
    input.spec_version !== "text-index-v1" ||
    !Array.isArray(input.documents) ||
    !input.documents.length ||
    input.documents.length > 20
  )
    throw fault("invalid_job_spec");
  let total = 0;
  for (const d of input.documents) {
    if (
      typeof d.id !== "string" ||
      typeof d.text !== "string" ||
      d.id.length > 100 ||
      d.text.length > 50000
    )
      throw fault("invalid_document");
    total += d.text.length;
  }
  if (
    total > 200000 ||
    new Set(input.documents.map((d) => d.id)).size !== input.documents.length
  )
    throw fault("job_resource_limit");
  return input;
}
export function textIndex(input) {
  checkJob(input);
  const docs = input.documents.map((d) => {
    const words = d.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const counts = new Map();
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
    return {
      id: d.id,
      input_hash: hash(d.text),
      characters: d.text.length,
      words: words.length,
      top_terms: [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 50)
        .map(([term, count]) => ({ term, count })),
    };
  });
  return {
    spec_version: "text-index-v1",
    documents: docs,
    total_words: docs.reduce((a, d) => a + d.words, 0),
    index_hash: hash(docs),
  };
}
export class Jobs {
  constructor(
    vault,
    { retentionMs = 86400000, leaseMs = 60000, processor = textIndex } = {},
  ) {
    Object.assign(this, { vault, retentionMs, leaseMs, processor });
  }
  prepare(input, payer, state) {
    checkJob(input);
    state.jobs ??= {};
    const id = randomUUID();
    state.jobs[id] = {
      id,
      operation_id: input.operation_id,
      payer,
      input,
      status: "ACCEPTED",
      created_at: Date.now(),
      expires_at: Date.now() + this.retentionMs,
      attempts: 0,
    };
    return {
      job_id: id,
      status: "ACCEPTED",
      pollUrl: "/v1/jobs/" + id,
      result: null,
      contract: {
        task: "text-index-v1",
        retention_seconds: this.retentionMs / 1000,
        expected_seconds: 30,
        failure_policy: "paid_unfulfilled_manual_review_no_automatic_refund",
      },
    };
  }
  async tick() {
    let claimed;
    await this.vault.transaction((s, save) => {
      s.jobs ??= {};
      for (const job of Object.values(s.jobs)) {
        const payment = s.payments?.[job.operation_id];
        if (payment?.payment_state !== "CONFIRMED") continue;
        if (job.status === "ACCEPTED") job.status = "QUEUED";
        if (job.status === "RUNNING" && job.lease_until > Date.now()) continue;
        if (!["QUEUED", "RUNNING"].includes(job.status)) continue;
        if (job.attempts >= 3) {
          job.status = "FAILED";
          job.issue = "worker_recovery_limit_manual_review";
          continue;
        }
        job.status = "RUNNING";
        job.attempts++;
        job.lease_id = randomUUID();
        job.lease_until = Date.now() + this.leaseMs;
        claimed = structuredClone(job);
        break;
      }
      save();
    });
    if (!claimed) return false;
    let result, error;
    try {
      result = await this.processor(claimed.input);
    } catch {
      error = "paid_unfulfilled_manual_review";
    }
    await this.vault.transaction((s, save) => {
      const job = s.jobs[claimed.id];
      if (job.lease_id !== claimed.lease_id) return;
      job.status = error ? "FAILED" : "SUCCEEDED";
      job.issue = error || null;
      job.result = error ? null : result;
      job.completed_at = Date.now();
      job.artifact_hash = result ? hash(result) : null;
      s.payments[job.operation_id].fulfillment_state = error
        ? "FAILED"
        : "READY";
      audit(s, "job_completed", { job_id: job.id, status: job.status });
      save();
    });
    return true;
  }
  async get(id, payer, includeResult = false) {
    return this.vault.transaction((s, save) => {
      const j = s.jobs?.[id];
      if (!j || j.payer !== payer) throw fault("job_not_found", 404);
      const payment = s.payments?.[j.operation_id];
      const expired = Date.now() > j.expires_at;
      if (expired && j.result) {
        delete j.result;
        save();
      }
      if (
        includeResult &&
        ((!expired && j.status !== "SUCCEEDED") ||
          payment?.payment_state !== "CONFIRMED")
      )
        throw fault("artifact_not_ready", 409);
      if (includeResult && expired) throw fault("artifact_expired", 410);
      if (includeResult) {
        j.retrieved_at = Date.now();
        audit(s, "job_retrieved", { job_id: id });
        save();
      }
      return {
        job_id: id,
        status: j.status,
        payment_state: payment?.payment_state || "UNKNOWN",
        pollUrl: "/v1/jobs/" + id,
        result: includeResult
          ? j.result
          : !expired && j.status === "SUCCEEDED"
            ? {
                artifact_url: "/v1/jobs/" + id + "/result",
                artifact_hash: j.artifact_hash,
              }
            : null,
        artifact_hash: j.artifact_hash,
        expires_at: new Date(j.expires_at).toISOString(),
        issue: j.issue || null,
      };
    });
  }
}
export async function pollJob({
  merchantUrl,
  pollUrl,
  session,
  request,
  attempts = 6,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const target = new URL(pollUrl, merchantUrl),
    base = new URL(merchantUrl);
  if (target.origin !== base.origin || target.username || target.password)
    throw fault("cross_origin_poll_rejected");
  for (let n = 0; n < attempts; n++) {
    const result = await request({
      url: target.href,
      session,
      method: "GET",
      redirect: "error",
    });
    if (result.status === "FAILED") return result;
    if (result.status === "SUCCEEDED" && result.result) {
      if (result.result.artifact_url) {
        const artifact = new URL(result.result.artifact_url, target);
        if (
          artifact.origin !== base.origin ||
          artifact.username ||
          artifact.password
        )
          throw fault("cross_origin_artifact_rejected");
        return request({
          url: artifact.href,
          session,
          method: "GET",
          redirect: "error",
        });
      }
      return result;
    }
    if (n + 1 < attempts) await wait(Math.min(1000 * 2 ** n, 15000));
  }
  return { status: "unresolved", pollUrl: target.href, repurchase: false };
}
