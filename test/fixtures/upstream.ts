import fs from "node:fs";

// Read each response from the test's temporary directory. Never call the network.
const root = process.env.CLINICAL_TRIALS_MCP_DATA_DIR!;
globalThis.fetch = async (_input, options) => {
  fs.appendFileSync(`${root}/requests`, "request\n");
  const fixture: { body?: unknown; status?: number; delayMs?: number } =
    JSON.parse(fs.readFileSync(`${root}/upstream.json`, "utf8"));
  if (fixture.delayMs) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, fixture.delayMs);
      options?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          fs.writeFileSync(`${root}/aborted`, "aborted");
          reject(options.signal?.reason);
        },
        { once: true },
      );
    });
  }
  options?.signal?.throwIfAborted();
  return new Response(JSON.stringify(fixture.body ?? {}), {
    status: fixture.status ?? 200,
    statusText: fixture.status === 400 ? "Bad Request" : "OK",
  });
};
