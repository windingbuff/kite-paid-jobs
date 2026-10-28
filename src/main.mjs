import { service } from "./service.mjs";
import { Jobs, checkJob } from "./jobs.mjs";
import { json } from "./http.mjs";
import { fault } from "./store.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const plugin = process.env.JOB_PROCESSOR_MODULE
  ? await import(pathToFileURL(resolve(process.env.JOB_PROCESSOR_MODULE)).href)
  : null;
const options = plugin
  ? {
      processor: plugin.process,
      validate: plugin.validate,
      specVersion: plugin.specVersion,
    }
  : {};
if (
  plugin &&
  (typeof plugin.process !== "function" ||
    typeof plugin.validate !== "function" ||
    !plugin.specVersion)
)
  throw Error(
    "Processor exports specVersion, validate and process are required",
  );
const createJobs = (vault) => new Jobs(vault, options);
let jobs;
const app = service({
  path: "/v1/jobs",
  port: 4407,
  precheck: async (input) => {
    if (plugin) {
      if (input.spec_version !== plugin.specVersion)
        throw fault("invalid_job_spec");
      plugin.validate(input);
      if (plugin.preflight) await plugin.preflight(input);
      return;
    }
    return checkJob(input);
  },
  prepare: ({ input, payer, state, vault }) => {
    jobs ??= createJobs(vault);
    return jobs.prepare(input, payer, state);
  },
  afterSettlement: (record) => {
    record.fulfillment_state = "NOT_STARTED";
  },
  extraRoute: async (req, res, path, { seller, vault }) => {
    const m = path.match(/^\/v1\/jobs\/([a-f0-9-]+)(\/result)?$/);
    if (!m || req.method !== "GET") return false;
    const identity = await seller.identity(path, req.headers["sign-in-with-x"]);
    if (!identity.payer) {
      json(res, identity.status, identity.body, identity.headers);
      return true;
    }
    jobs ??= createJobs(vault);
    json(res, 200, await jobs.get(m[1], identity.payer, Boolean(m[2])));
    return true;
  },
});
jobs = createJobs(app.vault);
app.start();
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await jobs.tick();
  } catch {
    console.error("worker checkpoint failed; inspect restricted journal");
  } finally {
    running = false;
  }
}, 1000).unref();
