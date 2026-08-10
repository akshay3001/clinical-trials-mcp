import fs from "node:fs";

const requestLog = process.env.CLINICAL_TRIALS_REGRESSION_REQUEST_LOG;

if (!requestLog) {
  throw new Error(
    "CLINICAL_TRIALS_REGRESSION_REQUEST_LOG is required by the regression mock",
  );
}

const fixtures = JSON.parse(
  fs.readFileSync(new URL("./fixtures/studies.json", import.meta.url), "utf8"),
);
const searchFixtures = fixtures.filter((study) => !study.regressionDetailOnly);
const fixturesById = new Map(
  fixtures.map((study) => [
    study.protocolSection.identificationModule.nctId,
    study,
  ]),
);
const attemptsByUrl = new Map();
let activeRequests = 0;

function scenarioFor(url) {
  const query = url.searchParams.get("query.term") ?? "";
  if (query === "retry-429-regression") return "retry-429";
  if (query === "retry-503-terminal-regression") return "retry-503-terminal";
  if (query === "malformed-json-regression") return "malformed-json";
  if (query === "schema-invalid-search-regression") {
    return "schema-invalid-search";
  }
  if (url.pathname === "/api/v2/studies/NCT00000005") {
    return "schema-invalid-detail";
  }
  if (query.startsWith("concurrency-regression-")) return "concurrency";
  return undefined;
}

function appendRequestLog(entry) {
  fs.appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

globalThis.fetch = async (input, init) => {
  const rawUrl =
    typeof input === "string" || input instanceof URL ? input : input.url;
  const url = new URL(rawUrl);

  if (
    url.origin !== "https://clinicaltrials.gov" ||
    !url.pathname.startsWith("/api/v2/studies")
  ) {
    throw new Error(`Regression harness blocked unexpected request: ${url}`);
  }

  const requestUrl = url.toString();
  const attempt = (attemptsByUrl.get(requestUrl) ?? 0) + 1;
  attemptsByUrl.set(requestUrl, attempt);
  const scenario = scenarioFor(url);
  activeRequests += 1;
  appendRequestLog({
    event: "request",
    method: init?.method ?? "GET",
    url: requestUrl,
    attempt,
    scenario,
    activeRequests,
  });

  try {
    if (scenario === "concurrency") await delay(80);
    if (scenario === "retry-429" && attempt === 1) {
      return new Response("too many requests", {
        status: 429,
        statusText: "Too Many Requests",
      });
    }
    if (scenario === "retry-503-terminal") {
      return new Response("service unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      });
    }
    if (scenario === "malformed-json") {
      return new Response("{not valid json", {
        headers: { "content-type": "application/json" },
      });
    }
    if (scenario === "schema-invalid-search") {
      return Response.json({
        studies: [
          {
            protocolSection: {
              identificationModule: {
                briefTitle: "Study missing its NCT identifier",
              },
              statusModule: { overallStatus: "RECRUITING" },
            },
          },
        ],
      });
    }
    if (scenario === "schema-invalid-detail") {
      return Response.json({
        protocolSection: {
          identificationModule: {
            briefTitle: "Detail study missing its NCT identifier",
          },
          statusModule: { overallStatus: "RECRUITING" },
        },
      });
    }

    const detailMatch = url.pathname.match(/^\/api\/v2\/studies\/(NCT\d+)$/);
    if (detailMatch) {
      const study = fixturesById.get(detailMatch[1]);
      if (!study) {
        return new Response("not found", {
          status: 404,
          statusText: "Not Found",
        });
      }

      return Response.json(study);
    }

    if (url.pathname !== "/api/v2/studies") {
      return new Response("not found", {
        status: 404,
        statusText: "Not Found",
      });
    }

    const pageSize = Number.parseInt(
      url.searchParams.get("pageSize") ?? "1000",
    );
    const offset = Number.parseInt(url.searchParams.get("pageToken") ?? "0");
    const end = Math.min(offset + pageSize, searchFixtures.length);

    return Response.json({
      studies: searchFixtures.slice(offset, end),
      nextPageToken: end < searchFixtures.length ? String(end) : undefined,
      totalCount: searchFixtures.length,
    });
  } finally {
    activeRequests -= 1;
    appendRequestLog({
      event: "response",
      method: init?.method ?? "GET",
      url: requestUrl,
      attempt,
      scenario,
      activeRequests,
    });
  }
};
