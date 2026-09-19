import { getPref, getString } from "../../utils";
import { TranslateService } from "./base";
import { MEDICAL_ABBREVIATIONS, MEDICAL_VOCABULARY } from "./medical-glossary-data";

// ── Pre-built sorted entries ──
const SORTED_ABBREVIATIONS = Array.from(MEDICAL_ABBREVIATIONS.entries())
  .sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase()));

const SORTED_VOCABULARY = Array.from(MEDICAL_VOCABULARY.entries())
  .sort(([a], [b]) => a.localeCompare(b));

// ── Translation cache ──
const CACHE_PREF_KEY = "medicalTranslator.cache";
// Bump CACHE_VERSION whenever the prompt/output format changes, so entries
// cached by older versions (with term annotations, etc.) are never reused.
const CACHE_VERSION = "v2";
const MAX_CACHE_ENTRIES = 100;
// Skip caching long results: they rarely repeat, and bloating prefs.js
// makes every save and Zotero startup slower.
const MAX_CACHE_ENTRY_LENGTH = 2000;

interface CacheEntry {
  result: string;
  timestamp: number;
}

let cacheDirty = false;

function loadCache(): Map<string, CacheEntry> {
  try {
    const raw = getPref(CACHE_PREF_KEY) as string;
    if (!raw) return new Map();
    const map = new Map<string, CacheEntry>();
    for (const [k, v] of Object.entries(JSON.parse(raw))) {
      if (!k.startsWith(`${CACHE_VERSION}|`)) continue; // drop stale-format entries
      const entry = v as CacheEntry;
      if (entry.result?.length <= MAX_CACHE_ENTRY_LENGTH) {
        map.set(k, entry);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveCache(cache: Map<string, CacheEntry>): void {
  if (!cacheDirty) return;
  try {
    if (cache.size > MAX_CACHE_ENTRIES) {
      const sorted = [...cache.entries()]
        .sort(([, a], [, b]) => a.timestamp - b.timestamp);
      for (const [k] of sorted.slice(0, cache.size - MAX_CACHE_ENTRIES)) {
        cache.delete(k);
      }
    }
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of cache) obj[k] = v;
    Zotero.Prefs.set(
      `extensions.zotero.ZoteroPDFTranslate.${CACHE_PREF_KEY}`,
      JSON.stringify(obj),
      true,
    );
    cacheDirty = false;
  } catch { /* non-critical */ }
}

const translationCache = loadCache();

// ── Custom glossary ──
function loadCustomGlossary(): Map<string, string> {
  try {
    const raw = (getPref("medicalTranslator.customGlossary") as string) || "";
    if (!raw.trim()) return new Map();
    const map = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
      const parts = trimmed.split(/\s*[:：=→>,-]\s*/);
      if (parts.length >= 2) {
        const en = parts[0].trim();
        const cn = parts.slice(1).join(":").trim();
        if (en && cn) {
          map.set(en, cn);
          map.set(en.toLowerCase(), cn);
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// ── Paper context extraction ──
// Title + abstract only, capped at 1000 chars. Extracting note attachments
// on every request was slow (HTML parsing on multi-MB notes) and blew up
// the matching pool without improving term matching.
function getPaperContext(itemId: number | undefined): string {
  if (!itemId) return "";
  try {
    const item = Zotero.Items.get(itemId);
    if (!item) return "";
    const topItem = Zotero.Items.getTopLevel([item])[0];
    if (!topItem) return "";
    const parts: string[] = [];
    const title = topItem.getField("title") as string;
    if (title) parts.push(`Title: ${title}`);
    const abstract = topItem.getField("abstractNote") as string;
    if (abstract) parts.push(`Abstract: ${abstract}`);
    return parts.join("\n\n").slice(0, 1000);
  } catch {
    return "";
  }
}

// ── Fast abbreviation scanner (single-pass mega-regex) ──
// Precompiled patterns — abbreviations are static, so compile once at load time
const BATCH_PATTERNS: RegExp[] = [];
for (let i = 0; i < SORTED_ABBREVIATIONS.length; i += 500) {
  const batch = SORTED_ABBREVIATIONS.slice(i, i + 500);
  BATCH_PATTERNS.push(
    new RegExp(
      batch.map(([a]) => `\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).join("|"),
      "gi",
    ),
  );
}

function fastScanAbbreviations(searchPool: string): Set<string> {
  const found = new Set<string>();
  for (const pattern of BATCH_PATTERNS) {
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(searchPool)) !== null) {
      found.add(m[0].toUpperCase());
    }
  }
  return found;
}

// ── Text-based term matching (no discipline filtering) ──
function findMatchingAbbreviations(
  sourceText: string,
  paperContext: string,
): Array<[string, readonly [string, string]]> {
  const searchPool = paperContext
    ? sourceText.toUpperCase() + " " + paperContext.toUpperCase()
    : sourceText.toUpperCase();

  const foundAbbrs = fastScanAbbreviations(searchPool);
  const matches: Array<[string, readonly [string, string]]> = [];

  for (const [abbr, entry] of SORTED_ABBREVIATIONS) {
    if (foundAbbrs.has(abbr)) {
      matches.push([abbr, entry]);
    }
    if (matches.length >= 30) break;
  }

  return matches;
}

// ── Word index for fast vocabulary pre-filtering ──
// Extracts all lowercase words from the search pool into a Set.
// Used to quickly skip vocabulary entries whose first word isn't present.
function buildWordIndex(text: string): Set<string> {
  const words = new Set<string>();
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || /\s/.test(text[i])) {
      if (i > start) words.add(text.slice(start, i));
      start = i + 1;
    }
  }
  return words;
}

function findMatchingVocabulary(
  sourceText: string,
  paperContext: string,
): Array<[string, string]> {
  const searchPool = paperContext
    ? sourceText.toLowerCase() + " " + paperContext.toLowerCase()
    : sourceText.toLowerCase();

  // Build word index once, reuse for pre-filtering every vocabulary entry
  const wordSet = buildWordIndex(searchPool);

  const matches: Array<[string, string]> = [];
  for (const [en, cn] of SORTED_VOCABULARY) {
    if (!(en.includes(" ") || en.length > 4)) continue;

    // Pre-filter: for multi-word terms, skip includes() if the first word
    // isn't even present in the search pool. This eliminates most entries
    // instantly with O(1) Set lookup instead of O(n) substring scan.
    if (en.includes(" ") && !wordSet.has(en.split(" ")[0])) continue;

    if (searchPool.includes(en)) {
      matches.push([en, cn]);
    }
    if (matches.length >= 20) break;
  }

  return matches;
}

// ── Build system prompt ──
function buildSystemPrompt(
  sourceText: string,
  paperContext: string,
  customGlossary: Map<string, string>,
): string {
  const matchedAbbrs = findMatchingAbbreviations(sourceText, paperContext);
  const matchedVocab = findMatchingVocabulary(sourceText, paperContext);

  let termRef = matchedAbbrs
    .map(([abbr, [fullEn, fullCn]]) => `${abbr}: ${fullEn} -> ${fullCn}`)
    .join("\n");

  let vocabRef = matchedVocab
    .map(([en, cn]) => `${en} -> ${cn}`)
    .join("\n");

  // Custom glossary at top (highest priority)
  if (customGlossary.size > 0) {
    const seen = new Set<string>();
    const customRef = Array.from(customGlossary.entries())
      // All-caps abbreviations, multi-word terms, and single words longer
      // than 4 chars. Short lowercase words are too common to inject.
      .filter(([k]) => k === k.toUpperCase() || k.includes(" ") || k.length > 4)
      // loadCustomGlossary stores each term twice (original + lowercased);
      // dedupe so both copies don't end up in the prompt.
      .filter(([k]) => {
        const lower = k.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      })
      .slice(0, 30)
      .map(([en, cn]) => `${en} -> ${cn}`)
      .join("\n");
    if (customRef) {
      termRef = `【用户自定义术语（最高优先级）】\n${customRef}\n\n【系统词库】\n${termRef}`;
    }
  }

  const contextIntro = paperContext
    ? `\n\n以下为当前文献的全文上下文，用于理解术语含义（非原文，仅用于术语辅助匹配）：\n${paperContext.slice(0, 1000)}`
    : "";

  return `你是一位资深医学翻译专家，专门为医学院校学生、临床规培医师和科研初学者服务。

你的核心任务：将英文医学文献翻译为中文，严格遵循以下规则：

1. **术语标准化**：优先使用《医学主题词表》(MeSH/CMeSH)中的标准译名。

以下是文中涉及的医学缩写对照参考（已自动匹配原文及全文中出现的术语）：
${termRef}

以下是文中涉及的通用医学术语对照参考：
${vocabRef}
${contextIntro}

2. **学术严谨性**：
   - 不添加原文没有的信息
   - 不删减原文内容
   - 不曲解原文含义
   - 保持段落的逻辑结构

3. **输出格式**：逐段翻译，段落之间用空行分隔。只输出译文本身，不要附加任何标注、括号解释或术语注释。`;
}

// ── Stream parsing ──
interface ParsedResponse {
  content: string;
  finished: boolean;
  error?: string;
}

function parseStreamResponse(obj: any): ParsedResponse {
  if (obj.error) {
    return {
      content: "",
      finished: true,
      error: obj.error.message || obj.error.code || JSON.stringify(obj.error),
    };
  }
  if (obj.choices && obj.choices[0]) {
    const choice = obj.choices[0];
    return {
      content: choice.delta?.content || "",
      finished: choice.finish_reason !== undefined && choice.finish_reason !== null,
    };
  }
  return { content: "", finished: false };
}

function parseNonStreamResponse(obj: any): ParsedResponse {
  if (obj.error) {
    return {
      content: "",
      finished: true,
      error: obj.error.message || obj.error.code || JSON.stringify(obj.error),
    };
  }
  if (obj.choices && obj.choices[0]) {
    return { content: obj.choices[0].message.content || "", finished: true };
  }
  return { content: "", finished: true };
}

// ── Main translate function ──
async function translate(
  data: Parameters<TranslateService["translate"]>[0],
): Promise<void> {
  const apiURL =
    (getPref("medicalTranslator.endPoint") as string) ||
    "https://api.deepseek.com/v1/chat/completions";
  const model =
    (getPref("medicalTranslator.model") as string) || "deepseek-flash";
  const temperature = parseFloat(
    (getPref("medicalTranslator.temperature") as string) || "0.3",
  );
  const stream = (getPref("medicalTranslator.stream") as boolean) ?? true;

  // Step 0: Load custom glossary, then check cache
  const customGlossary = loadCustomGlossary();
  // Include temperature and the custom glossary in the key: changing either
  // must invalidate cached results, otherwise users get stale translations.
  const glossaryHash =
    customGlossary.size > 0
      ? [...customGlossary.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(";")
      : "";
  const cacheKey = `${CACHE_VERSION}|${data.raw}|${data.langfrom || "en"}|${data.langto || "zh-CN"}|${model}|${temperature}|${glossaryHash}`;
  const cached = translationCache.get(cacheKey);
  if (cached) {
    // Update LRU order in memory only; no need to persist on a pure hit.
    cached.timestamp = Date.now();
    data.result = cached.result;
    data.status = "success";
    return;
  }

  const refreshHandler = addon.api.getTemporaryRefreshHandler({ task: data });

  // Debounced refresh: stream events fire rapidly (tens of times per second),
  // but DOM updates are expensive. 50ms throttle keeps UI smooth without
  // visible lag — the human eye can't distinguish refresh above ~20 Hz.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResult = "";

  const debouncedRefresh = () => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (pendingResult !== data.result) {
        pendingResult = data.result;
        refreshHandler();
      }
    }, 50);
  };

  if (stream === false) {
    data.result = getString("status-translating");
    refreshHandler();  // immediate: only fires once, no debounce needed
  }

  // Step 1: Extract paper context
  const paperContext = getPaperContext(data.itemId);

  // Step 2: Build prompt
  const systemPrompt = buildSystemPrompt(data.raw, paperContext, customGlossary);
  const userContent = `请翻译以下英文医学文献段落：\n\n${data.raw}`;

  const requestBody = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature,
    stream,
  };

  // ── Streaming callback ──
  const streamCallback = (xmlhttp: XMLHttpRequest) => {
    let preLength = 0;
    let result = "";
    let buffer = "";
    let streamError = "";

    xmlhttp.onprogress = (e: any) => {
      const newResponse = e.target.response.slice(preLength);
      const fullResponse = buffer + newResponse;
      const dataArray = fullResponse.split("data:");
      buffer = "";

      for (let i = 0; i < dataArray.length; i++) {
        const chunk = dataArray[i];
        if (!chunk.trim()) continue;
        try {
          const obj = JSON.parse(chunk);
          const { content, finished, error } = parseStreamResponse(obj);
          if (error) {
            streamError = error;
            data.status = "fail";
            break;
          }
          result += content;
          if (finished) break;
        } catch {
          if (i === dataArray.length - 1) buffer = "data:" + chunk;
          continue;
        }
      }

      if (e.target.timeout) e.target.timeout = 0;
      data.result = streamError
        ? `API error: ${streamError}`
        : result.replace(/^\n\n/, "");
      preLength = e.target.response.length;
      debouncedRefresh();
    };
  };

  // ── Non-streaming callback ──
  const nonStreamCallback = (xmlhttp: XMLHttpRequest) => {
    xmlhttp.onload = () => {
      try {
        const responseObj = JSON.parse(xmlhttp.responseText);
        const { content, error } = parseNonStreamResponse(responseObj);
        if (error) {
          data.status = "fail";
          data.result = `API error: ${error}`;
        } else {
          data.result = content.replace(/^\n\n/, "");
        }
      } catch {
        data.status = "fail";
        data.result = "API error: invalid response";
        refreshHandler();
        return;
      }
      refreshHandler();
    };
  };

  const xhr = await Zotero.HTTP.request("POST", apiURL, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.secret}`,
    },
    body: JSON.stringify(requestBody),
    responseType: "text",
    requestObserver: (xmlhttp: XMLHttpRequest) => {
      if (stream) streamCallback(xmlhttp);
      else nonStreamCallback(xmlhttp);
    },
  });

  if (xhr?.status !== 200) {
    data.status = "fail";
    throw `Request error: ${xhr?.status}`;
  }

  // Step 4: Save cache (only successful, non-empty results under the size cap)
  if (data.status !== "fail" && data.result && data.result.length <= MAX_CACHE_ENTRY_LENGTH) {
    translationCache.set(cacheKey, { result: data.result, timestamp: Date.now() });
    cacheDirty = true;
  }
  saveCache(translationCache);

  // Flush any pending debounced refresh before returning
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  refreshHandler();

  if (data.status === "fail") return;
  if (!data.result || !data.result.trim()) {
    data.status = "fail";
    data.result = "API error: empty response";
    refreshHandler();
    return;
  }

  data.status = "success";
}

export const MedicalTranslator: TranslateService = {
  id: "medical-translator",
  type: "sentence",
  helpUrl: "https://api-docs.deepseek.com/",
  defaultSecret: "",

  secretValidator(secret: string) {
    const status = /^sk-[A-Za-z0-9]{32,}$/.test(secret);
    const empty = secret.length === 0;
    return {
      secret,
      status,
      info: empty
        ? "The secret is not set. Please enter your DeepSeek API key."
        : status
          ? "Click the button to check connectivity."
          : "Invalid DeepSeek API key format. Keys start with 'sk-' and are at least 35 characters.",
    };
  },

  translate,

  config(settings) {
    settings
      .addTextSetting({
        prefKey: "medicalTranslator.endPoint",
        nameKey: "service-medicaltranslator-dialog-endPoint",
      })
      .addTextSetting({
        prefKey: "medicalTranslator.model",
        nameKey: "service-medicaltranslator-dialog-model",
      })
      .addNumberSetting({
        prefKey: "medicalTranslator.temperature",
        nameKey: "service-medicaltranslator-dialog-temperature",
        min: 0, max: 2, step: 0.1,
      })
      .addCheckboxSetting({
        prefKey: "medicalTranslator.stream",
        nameKey: "service-medicaltranslator-dialog-stream",
      })
      .addTextAreaSetting({
        prefKey: "medicalTranslator.customGlossary",
        nameKey: "service-medicaltranslator-dialog-customGlossary",
        placeholder: `# 自定义术语对照表（一行一条，优先级最高）
# 格式：英文缩写或术语 → 中文译名
# 以 # 开头的行为注释
MACE → 主要心血管不良事件
PCI → 经皮冠状动脉介入治疗`,
      });
  },
};
