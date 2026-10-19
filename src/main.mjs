import { service } from "./service.mjs";
import { Jobs, checkJob } from "./jobs.mjs";
import { json } from "./http.mjs";
let jobs;
const app = service({
  path: "/v1/jobs",
  port: 4407,
  precheck: checkJob,
  prepare: ({ input, payer, state, vault }) => {
    jobs ??= new Jobs(vault);
    return jobs.prepare(input, payer, state);
  },
  extraRoute: async (req, res, path, { seller, vault }) => {
    const m = path.match(/^\/v1\/jobs\/([a-f0-9-]+)(\/result)?$/);
    if (!m || req.method !== "GET") return false;
    const identity = await seller.identity(path, req.headers["sign-in-with-x"]);
    if (!identity.payer) {
      json(res, identity.status, identity.body, identity.headers);
      return true;
    }
    jobs ??= new Jobs(vault);
    json(res, 200, await jobs.get(m[1], identity.payer, Boolean(m[2])));
    return true;
  },
});
jobs = new Jobs(app.vault);
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
