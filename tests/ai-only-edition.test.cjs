const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const modelIds = [
  "medical-translator",
  "azuregpt",
  "chatgpt",
  "claude",
  "gemini",
  "qwenmt",
  "youdaozhiyunllm",
  "customgpt1",
  "customgpt2",
  "customgpt3",
];
const compiled = new Map();

function harness(overrides = {}, locale = "zh-CN") {
  const prefs = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(root, "addon/prefs.js"), "utf8"),
    {
      pref: (key, value) => {
        prefs[key.replace("__prefsPrefix__.", "")] = value;
      },
    },
  );
  Object.assign(prefs, overrides);
  const menus = new Map();
  const elements = new Map();
  const doc = {
    querySelector(selector) {
      if (!elements.has(selector))
        elements.set(selector, {
          checked: false,
          value: "",
          addEventListener() {},
          getAttribute: () => "",
          setAttribute() {},
        });
      return elements.get(selector);
    },
    querySelectorAll: () => [],
  };
  const addon = {
    data: {
      translate: { queue: [], maximumQueueLength: 1000 },
      panel: { windowPanel: null },
      prefs: {},
    },
    api: { getTemporaryRefreshHandler: () => () => {} },
    hooks: { onReaderTabPanelRefresh() {} },
  };
  const utils = {
    getPref: (key) => prefs[key],
    setPref: (key, value) => {
      prefs[key] = value;
    },
    clearPref: (key) => {
      delete prefs[key];
    },
    getPrefJSON: (key) => JSON.parse(prefs[key] || "{}"),
    getString: (key) => key,
    getServiceSecret: (id) => JSON.parse(prefs.secretObj || "{}")[id] || "",
    validateServiceSecret: (id) => ({
      secret: utils.getServiceSecret(id),
      status: true,
    }),
    getLastTranslateTask: () => undefined,
    transformPromptWithContext: (_key, _from, _to, text) => text,
  };
  const Zotero = {
    locale,
    PDFTranslate: addon,
    Utilities: { randomString: () => "test-id" },
  };
  const context = vm.createContext({
    Zotero,
    addon,
    rootURI: "test://",
    setTimeout,
    clearTimeout,
    ztoolkit: {
      log() {},
      UI: {
        replaceElement: (element) => {
          menus.set(element.id, element);
        },
      },
    },
  });
  const modules = new Map();
  function load(relativeFile) {
    const filename = path.resolve(root, relativeFile);
    if (modules.has(filename)) return modules.get(filename).exports;
    if (filename.endsWith(".json"))
      return JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!compiled.has(filename))
      compiled.set(
        filename,
        ts.transpileModule(fs.readFileSync(filename, "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
      );
    const module = { exports: {} };
    modules.set(filename, module);
    const localRequire = (id) => {
      if (
        [
          "../../utils",
          "../utils",
          "../utils/prefs",
          "../utils/secret",
          "../utils/locale",
          "./prefs",
          "./secret",
          "./locale",
          "../../utils/prefs",
          "../../utils/locale",
        ].includes(id)
      )
        return utils;
      if (["./config", "../utils/config"].includes(id))
        return { LANG_CODE: [{ code: "en", name: "English" }] };
      const resolved = path.resolve(path.dirname(filename), id);
      if (fs.existsSync(`${resolved}.ts`)) return load(`${resolved}.ts`);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())
        return load(path.join(resolved, "index.ts"));
      return load(resolved);
    };
    vm.runInContext(
      `(function(require, module, exports) { ${compiled.get(filename)}\n})`,
      context,
      { filename },
    )(localRequire, module, module.exports);
    return module.exports;
  }
  const services = load("src/modules/services/index.ts").services;
  addon.data.translate.services = services;
  return {
    prefs,
    menus,
    services,
    load,
    doc,
    addon,
    ztoolkit: context.ztoolkit,
    Zotero,
  };
}

test("public registry exposes only AI model APIs, with medical translation first", () => {
  const h = harness();
  assert.deepEqual(
    Array.from(h.services.getAllServices(), (s) => s.id),
    modelIds,
  );
  assert.equal(h.services.getAllServicesWithType("word").length, 0);
  for (const service of h.services.getAllServices()) {
    assert.equal(service.type, "sentence");
    assert.equal(typeof service.translate, "function");
    assert.equal(typeof service.config, "function");
  }
  for (const id of [
    "bing",
    "cnki",
    "google",
    "googleapi",
    "deeplfree",
    "deeplpro",
    "deeplx",
    "bingdict",
    "freedictionaryapi",
    "niutransLog",
  ]) {
    assert.equal(h.services.getServiceById(id), undefined);
  }
});

test("fresh Chinese and English installs default to medical AI and have no dictionary routing", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const h = harness({}, locale);
    h.load("src/modules/defaultPrefs.ts").setDefaultPrefSettings();
    assert.equal(h.prefs.translateSource, "medical-translator");
    assert.equal(h.prefs.enableDict, false);
    assert.equal(h.prefs.dictSource, "");
    assert.equal(h.prefs.showPlayBtn, false);
    assert.equal(h.prefs.targetLanguage, locale);
  }
});

test("upgrading retired services chooses medical AI and cleans extra engines", () => {
  for (const id of [
    "",
    "bing",
    "cnki",
    "googleapi",
    "niutransLog",
    "missing-engine",
  ]) {
    const h = harness({
      translateSource: id,
      enableDict: true,
      dictSource: "bingdict",
      showPlayBtn: true,
      autoPlay: true,
      extraEngines:
        ",cnki, gemini ,bing,customgpt2,,medical-translator,unknown",
    });
    const migrate = h.load(
      "src/modules/defaultPrefs.ts",
    ).setDefaultPrefSettings;
    migrate();
    assert.equal(h.prefs.translateSource, "medical-translator");
    assert.equal(h.prefs.extraEngines, "gemini,customgpt2,medical-translator");
    assert.equal(h.prefs.autoPlay, false);
    const once = JSON.stringify(h.prefs);
    migrate();
    assert.equal(JSON.stringify(h.prefs), once, "migration is idempotent");
  }
});

test("existing AI selections, keys, endpoints, models, terms and languages survive upgrading", () => {
  for (const id of modelIds) {
    const secrets = { [id]: "saved-test-key", cnki: "retired-saved-key" };
    const saved = {
      translateSource: id,
      secretObj: JSON.stringify(secrets),
      "customGPT2.endPoint": "http://localhost:11434/v1/chat/completions",
      "customGPT2.model": "local-model",
      "customGPT2.temperature": "0.4",
      "medicalTranslator.customGlossary": "PCI → 经皮冠状动脉介入治疗",
      "medicalTranslator.model": "saved-model",
      targetLanguage: "ja",
      sourceLanguage: "en",
    };
    const h = harness(saved);
    h.load("src/modules/defaultPrefs.ts").setDefaultPrefSettings();
    for (const [key, value] of Object.entries(saved)) {
      if (key !== "secretObj") assert.equal(h.prefs[key], value, key);
    }
    const actual = JSON.parse(h.prefs.secretObj);
    for (const [key, value] of Object.entries(secrets))
      assert.equal(actual[key], value);
  }
});

test("single words and sentences use the selected AI even with stale dictionary preferences", () => {
  const h = harness({
    translateSource: "customgpt2",
    enableDict: true,
    dictSource: "bingdict",
  });
  const addTask = h.load("src/utils/task.ts").addTranslateTask;
  for (const text of ["hypospadias", "The dose is 5 mg.", "尿道下裂"]) {
    const task = addTask(text);
    assert.equal(task.service, "customgpt2");
    assert.equal(task.candidateServices.length, 0);
  }
});

test("custom model interfaces still expose endpoint, model and generation settings", () => {
  const h = harness();
  for (const id of ["customgpt1", "customgpt2", "customgpt3"]) {
    const keys = [];
    const settings = new Proxy(
      {},
      {
        get: () => (options) => {
          keys.push(options.prefKey);
          return settings;
        },
      },
    );
    h.services.getServiceById(id).config(settings);
    const prefix = id.replace("gpt", "GPT");
    for (const key of [
      "endPoint",
      "model",
      "temperature",
      "prompt",
      "stream",
    ]) {
      assert.ok(keys.includes(`${prefix}.${key}`), `${id}: ${key}`);
    }
  }
});

test("preferences initialize with the same AI menu and no dictionary menu", () => {
  const h = harness();
  h.load("src/modules/defaultPrefs.ts").setDefaultPrefSettings();
  h.load("src/modules/preferenceWindow.ts").registerPrefsScripts({
    document: h.doc,
  });
  const menu = h.menus.get("zoteropdftranslate-sentenceServices");
  assert.deepEqual(
    Array.from(menu.children[0].children, (item) => item.attributes.value),
    modelIds,
  );
  assert.equal(h.menus.has("zoteropdftranslate-wordServices"), false);
});

test("extra engines cannot queue retired services even when a stale list is edited at runtime", () => {
  const h = harness({
    extraEngines: "cnki,gemini, bingdict , customgpt1 ,unknown",
  });
  h.addon.data.panel.windowPanel = { closed: false };
  const task = h
    .load("src/utils/task.ts")
    .addTranslateTask("A clinical sentence.");
  assert.deepEqual(
    Array.from(task.extraTasks, (task) => task.service),
    ["gemini", "customgpt1"],
  );
});

function mockKeyEditor(h, replacement) {
  let displayed;
  h.ztoolkit.Dialog = class {
    setDialogData(data) {
      this.data = data;
      return this;
    }
    addCell() {
      return this;
    }
    addButton() {
      return this;
    }
    open() {
      displayed = JSON.parse(this.data.secrets);
      this.data._lastButtonId = "save";
      this.data.secrets = JSON.stringify(replacement);
      return this;
    }
  };
  return () => displayed;
}

test("key manager displays only AI services and updates them without deleting retired saved keys", async () => {
  const h = harness({
    secretObj: JSON.stringify({ gemini: "old-ai-key", cnki: "old-legacy-key" }),
  });
  const displayed = mockKeyEditor(h, { gemini: "new-test-key" });
  assert.equal(
    await h.load("src/modules/settings/manageKeys.ts").manageKeysDialog(),
    true,
  );
  assert.deepEqual(Object.keys(displayed()), modelIds);
  const saved = JSON.parse(h.prefs.secretObj);
  assert.equal(saved.gemini, "new-test-key");
  assert.equal(saved.cnki, "old-legacy-key");
  assert.equal(saved.customgpt1, "");
});

test("key manager rejects malformed or non-AI entries without overwriting stored keys", async () => {
  for (const replacement of [
    null,
    [],
    "invalid",
    { gemini: 42 },
    { cnki: "key" },
  ]) {
    const h = harness({
      secretObj: JSON.stringify({ gemini: "existing-key" }),
    });
    const saved = h.prefs.secretObj;
    mockKeyEditor(h, replacement);
    assert.equal(
      await h.load("src/modules/settings/manageKeys.ts").manageKeysDialog(),
      false,
    );
    assert.equal(h.prefs.secretObj, saved);
  }
});
