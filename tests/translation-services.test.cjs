const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const compiled = new Map();
const cachePref = "medicalTranslator.cache";

function chatJSON(content = "Translated text", finishReason = "stop") {
  return JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
  });
}

function chatStream(content = "Translated text", finishReason = "stop") {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\r\n\r\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\r\n\r\n` +
    "data: [DONE]\r\n\r\n"
  );
}

function geminiJSON(content = "Translated text", finishReason = "STOP") {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: content }] }, finishReason }],
  });
}

function task(overrides = {}) {
  return {
    id: "test-task",
    type: "text",
    raw: "The treatment was not associated with an increased risk.",
    result: "",
    audio: [],
    service: "medical-translator",
    candidateServices: [],
    itemId: undefined,
    langfrom: "en",
    langto: "zh-CN",
    secret: "test-key",
    status: "processing",
    extraTasks: [],
    ...overrides,
  };
}

// Load real services with Zotero's preferences, HTTP and UI supplied by mocks.
function harness(initialPrefs = {}) {
  const prefs = {
    "medicalTranslator.stream": true,
    "gemini.stream": true,
    "gemini.endPoint": "https://example.test/models/test",
    ...initialPrefs,
  };
  const requests = [];
  const responses = [];
  const items = new Map();
  const writes = [];
  const timers = new Set();
  const refreshes = [];
  const addon = {
    data: { ztoolkit: { log() {} } },
    api: {
      getTemporaryRefreshHandler:
        ({ task: currentTask }) =>
        () => {
          refreshes.push(currentTask.id);
        },
    },
  };
  const utils = {
    getPref: (key) => prefs[key],
    getString: (key) => key,
    getServiceSecret: () => "test-key",
    transformPromptWithContext: (_key, _from, _to, text) => text,
  };
  const Zotero = {
    PDFTranslate: addon,
    Utilities: {
      Internal: {
        md5: (text) => createHash("md5").update(text).digest("hex"),
      },
    },
    Prefs: {
      set: (key, value) => {
        prefs[key.replace("extensions.zotero.ZoteroPDFTranslate.", "")] = value;
        writes.push(value);
      },
    },
    Items: { get: (id) => items.get(id), getTopLevel: (entries) => entries },
    HTTP: {
      async request(method, url, options) {
        requests.push({ method, url, options, body: JSON.parse(options.body) });
        const response = responses.shift() || {};
        const xhr = { status: response.status ?? 200, responseText: "" };
        options.requestObserver(xhr);
        await Promise.resolve();
        if (response.wait) await response.wait;
        if (response.error) throw response.error;
        const stream =
          JSON.parse(options.body).stream ?? url.includes("alt=sse");
        const body = response.body ?? (stream ? chatStream() : chatJSON());
        for (const chunk of response.chunks || [body]) {
          xhr.responseText += chunk;
          xhr.onprogress?.({ target: xhr });
        }
        if (response.finalText !== undefined)
          xhr.responseText = response.finalText;
        return xhr;
      },
    },
  };
  const context = vm.createContext({
    Zotero,
    addon,
    Error,
    setTimeout(callback, delay) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
      clearTimeout(timer);
    },
  });
  const modules = new Map();
  function load(relativeFile) {
    const filename = path.resolve(root, relativeFile);
    if (modules.has(filename)) return modules.get(filename).exports;
    if (filename.endsWith(".json"))
      return JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!compiled.has(filename)) {
      compiled.set(
        filename,
        ts.transpileModule(fs.readFileSync(filename, "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
      );
    }
    const module = { exports: {} };
    modules.set(filename, module);
    const localRequire = (id) => {
      if (["../../utils", "./locale", "./prefs", "./secret"].includes(id))
        return utils;
      if (id === "./config") return {};
      const resolved = path.resolve(path.dirname(filename), id);
      return load(resolved.endsWith(".json") ? resolved : `${resolved}.ts`);
    };
    vm.runInContext(
      `(function(require, module, exports) { ${compiled.get(filename)}\n})`,
      context,
      {
        filename,
      },
    )(localRequire, module, module.exports);
    return module.exports;
  }
  return {
    prefs,
    requests,
    responses,
    items,
    writes,
    timers,
    refreshes,
    load,
    medical: () =>
      load("src/modules/services/medical-translator.ts").MedicalTranslator,
    gemini: () => load("src/modules/services/gemini.ts").Gemini,
  };
}

test("medical SSE survives single-character chunks, CRLF, comments and literal data:", async () => {
  const h = harness();
  const body =
    "\uFEFF: keepalive\r\nevent: message\r\n" +
    chatStream("Dose (5 mg); data: retained.");
  h.responses.push({ chunks: [...body] });
  const data = task();
  await h.medical().translate(data);
  assert.equal(data.result, "Dose (5 mg); data: retained.");
  assert.equal(data.status, "success");
  assert.equal(h.timers.size, 0);
  assert.ok(h.requests[0].options.timeout > 0);
  assert.equal(h.requests[0].options.errorDelayMax, 0);
});

test("medical SSE parses multiline data and final bytes without a final progress event", async () => {
  const h = harness();
  const body =
    'data: {"choices": [\ndata: {"delta": {"content": "Complete"}, "finish_reason": "stop"}]}';
  h.responses.push({ chunks: [body.slice(0, 12)], finalText: body });
  const data = task();
  await h.medical().translate(data);
  assert.equal(data.result, "Complete");
});

test("API, malformed, empty and truncated responses reject and never enter cache", async (t) => {
  const cases = [
    {
      stream: true,
      body: 'data: {"error":{"message":"quota exhausted"}}\n\n',
      error: /quota exhausted/,
    },
    {
      stream: true,
      body: "data: invalid-json\n\ndata: [DONE]\n\n",
      error: /JSON|invalid response/,
    },
    {
      stream: true,
      body: 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n',
      error: /interrupted/,
    },
    {
      stream: true,
      body: chatStream("Partial", "length"),
      error: /Incomplete/,
    },
    {
      stream: false,
      body: chatJSON("Partial", "content_filter"),
      error: /Incomplete/,
    },
    {
      stream: false,
      body: '{"error":{"message":"invalid model"}}',
      error: /invalid model/,
    },
    { stream: false, body: "not JSON", error: /invalid response/ },
    { stream: false, body: chatJSON(" "), error: /empty response/ },
  ];
  for (const entry of cases) {
    await t.test(
      entry.error.toString() + " " + entry.body.slice(0, 35),
      async () => {
        const h = harness({ "medicalTranslator.stream": entry.stream });
        h.responses.push(entry);
        const data = task();
        await assert.rejects(h.medical().translate(data), entry.error);
        assert.equal(data.status, "fail");
        assert.equal(h.writes.length, 0);
        assert.equal(h.timers.size, 0);
        await h.medical().translate(task());
        assert.equal(h.requests.length, 2);
      },
    );
  }
});

test("task runner displays medical API failures as failures", async () => {
  const h = harness({ "medicalTranslator.stream": false });
  h.responses.push({ body: '{"error":{"message":"quota exhausted"}}' });
  const { TranslateTaskRunner } = h.load("src/utils/task.ts");
  const runner = new TranslateTaskRunner(h.medical().translate);
  const data = task();
  await runner.run(data);
  assert.equal(data.status, "fail");
  assert.match(data.result, /quota exhausted/);
});

test("three concurrent identical translations share one request and one successful result", async () => {
  const h = harness();
  let release;
  h.responses.push({
    wait: new Promise((resolve) => {
      release = resolve;
    }),
  });
  const data = [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })];
  const pending = data.map((entry) => h.medical().translate(entry));
  assert.equal(h.requests.length, 1);
  release();
  await Promise.all(pending);
  assert.equal(h.writes.length, 1);
  for (const entry of data) {
    assert.equal(entry.result, "Translated text");
    assert.equal(entry.status, "success");
    assert.ok(h.refreshes.includes(entry.id));
  }
  assert.equal(h.timers.size, 0);
});

test("shared failures reject every subscriber and a retry starts a new request", async () => {
  const h = harness();
  h.responses.push({ error: new Error("network failure") });
  const outcomes = await Promise.allSettled([
    h.medical().translate(task()),
    h.medical().translate(task()),
  ]);
  assert.deepEqual(
    outcomes.map((entry) => entry.status),
    ["rejected", "rejected"],
  );
  assert.equal(h.requests.length, 1);
  assert.equal(h.writes.length, 0);
  assert.equal(h.timers.size, 0);
  await h.medical().translate(task());
  assert.equal(h.requests.length, 2);
});

test("requests with different credentials do not share network failures", async () => {
  const h = harness();
  await Promise.all([
    h.medical().translate(task()),
    h.medical().translate(task({ secret: "other-key" })),
  ]);
  assert.equal(h.requests.length, 2);
});

test("cache hits skip HTTP and preference writes, including after reload", async () => {
  const h = harness();
  await h.medical().translate(task());
  await h.medical().translate(task());
  assert.equal(h.requests.length, 1);
  assert.equal(h.writes.length, 1);
  const persisted = h.prefs[cachePref];
  const key = Object.keys(JSON.parse(persisted))[0];
  assert.match(key, /^v4\|[a-f0-9]{32}$/);
  assert.ok(!persisted.includes("test-key"));
  const reloaded = harness({ [cachePref]: persisted });
  const data = task();
  await reloaded.medical().translate(data);
  assert.equal(data.result, "Translated text");
  assert.equal(reloaded.requests.length, 0);
});

test("cache invalidates for endpoint, model, temperature, languages, glossary and edited context", async () => {
  const h = harness();
  const metadata = { title: "Study A", abstractNote: "An abstract" };
  h.items.set(1, { getField: (field) => metadata[field] });
  const data = task({ itemId: 1 });
  await h.medical().translate({ ...data });
  for (const [key, value] of [
    ["medicalTranslator.endPoint", "https://other.test/chat/completions"],
    ["medicalTranslator.model", "other-model"],
    ["medicalTranslator.temperature", "0.8"],
    ["medicalTranslator.customGlossary", "risk: Custom risk"],
  ]) {
    h.prefs[key] = value;
    await h.medical().translate({ ...data });
  }
  await h.medical().translate({ ...data, langfrom: "fr" });
  await h.medical().translate({ ...data, langto: "en" });
  metadata.title = "Study B";
  await h.medical().translate({ ...data });
  assert.equal(h.requests.length, 8);
});

test("large results and old or malformed cache entries are not persisted or reused", async () => {
  const h = harness({
    [cachePref]: '{"v3|old":{"result":"Old","timestamp":1},"v4|bad":null}',
  });
  h.responses.push({ body: chatStream("x".repeat(2001)) });
  await h.medical().translate(task());
  assert.equal(h.writes.length, 0);
  await h.medical().translate(task());
  assert.equal(h.requests.length, 2);
});

test("matching preserves acronym case, word boundaries and relevant custom terms beyond 30 entries", async () => {
  const irrelevant = Array.from(
    { length: 35 },
    (_, i) => `Unrelated${i}: ignored`,
  ).join("\n");
  const h = harness({
    "medicalTranslator.customGlossary":
      irrelevant +
      "\nTNF-alpha => Custom TNF\nT-cell: Custom T cell\nIL-6 → Custom IL6\n1,25-dihydroxyvitamin D = Custom vitamin",
  });
  await h.medical().translate(
    task({
      raw: "mMRC as an outcome, or an adrenal, response. TNF-alpha and T-cell; IL-6 and 1,25-dihydroxyvitamin D.",
    }),
  );
  const prompt = h.requests[0].body.messages[0].content;
  assert.match(prompt, /mMRC: Modified Medical Research Council/);
  assert.doesNotMatch(prompt, /\nOR:|\nAS:|\nrenal ->/);
  assert.match(prompt, /adrenal ->/);
  assert.match(prompt, /TNF-alpha -> Custom TNF/);
  assert.match(prompt, /T-cell -> Custom T cell/);
  assert.match(prompt, /IL-6 -> Custom IL6/);
  assert.match(prompt, /1,25-dihydroxyvitamin D -> Custom vitamin/);
  assert.doesNotMatch(prompt, /Unrelated\d+ ->/);
});

test("medical prompt follows requested languages and protects existing parentheses and uncertainty", async () => {
  const h = harness();
  await h
    .medical()
    .translate(
      task({ langfrom: "zh-CN", langto: "en", raw: "A dose (5 mg)." }),
    );
  const request = h.requests[0].body;
  assert.match(request.messages[0].content, /将 zh-CN 医学文献翻译为 en/);
  assert.match(request.messages[0].content, /原文已有的括号和解释必须保留/);
  assert.match(request.messages[0].content, /否定|置信区间/);
  assert.match(request.messages[1].content, /从 zh-CN 翻译为 en/);
});

test("Gemini SSE survives fragmentation and flushes final bytes", async () => {
  const h = harness();
  const body = `event: message\r\ndata: ${geminiJSON("Gemini data: result")}\r\n\r\n`;
  h.responses.push({ chunks: [...body.slice(0, -8)], finalText: body });
  const data = task();
  await h.gemini().translate(data);
  assert.equal(data.result, "Gemini data: result");
  assert.equal(data.status, "success");
  assert.equal(h.timers.size, 0);
  assert.ok(!h.requests[0].url.includes(data.secret));
  assert.equal(h.requests[0].options.headers["x-goog-api-key"], data.secret);
});

test("Gemini non-stream output excludes reasoning and alternative candidates", async () => {
  const h = harness({ "gemini.stream": false });
  h.responses.push({
    body: JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: "Internal reasoning", thought: true },
              { text: "Translation" },
            ],
          },
          finishReason: "STOP",
        },
        { content: { parts: [{ text: "Alternative" }] }, finishReason: "STOP" },
      ],
    }),
  });
  const data = task();
  await h.gemini().translate(data);
  assert.equal(data.result, "Translation");
});

test("Gemini API errors, blocked, truncated, interrupted and empty responses reject", async (t) => {
  for (const entry of [
    {
      stream: false,
      body: '{"error":{"message":"bad key"}}',
      error: /bad key/,
    },
    {
      stream: false,
      body: '{"promptFeedback":{"blockReason":"SAFETY"}}',
      error: /SAFETY/,
    },
    {
      stream: false,
      body: geminiJSON("Partial", "MAX_TOKENS"),
      error: /incomplete/,
    },
    {
      stream: true,
      body: `data: ${geminiJSON("Partial", null)}\n\n`,
      error: /interrupted/,
    },
    { stream: false, body: geminiJSON(""), error: /empty response/ },
    {
      stream: true,
      body: "data: invalid-json\n\n",
      error: /JSON|invalid response/,
    },
  ]) {
    await t.test(entry.error.toString(), async () => {
      const h = harness({ "gemini.stream": entry.stream });
      h.responses.push(entry);
      const data = task();
      await assert.rejects(h.gemini().translate(data), entry.error);
      assert.equal(data.status, "fail");
      assert.equal(h.timers.size, 0);
    });
  }
});
