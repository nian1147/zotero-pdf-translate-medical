import { getPref, getString } from "../../utils";
import { TranslateService } from "./base";
import {
  MEDICAL_ABBREVIATIONS,
  MEDICAL_VOCABULARY,
  ABBREVIATION_DISCIPLINES,
  VOCABULARY_DISCIPLINES,
  MAJOR_DISCIPLINES,
} from "./medical-glossary-data";

// ── Pre-built sorted entries (computed once on module load) ──
const SORTED_ABBREVIATIONS = Array.from(MEDICAL_ABBREVIATIONS.entries())
  .sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase()));

const SORTED_VOCABULARY = Array.from(MEDICAL_VOCABULARY.entries())
  .sort(([a], [b]) => a.localeCompare(b));

// ── High-frequency core terms (always included as fallback) ──
const CORE_TERMS = [
  "STEMI", "NSTEMI", "PCI", "CABG", "ACS", "HF", "AF", "MI", "HTN",
  "COPD", "ARDS", "CVA", "TIA", "MRI", "CT", "PET", "DM", "RCT",
  "OS", "PFS", "LVEF", "MACE", "CAD", "PE", "OSA", "CKD", "IBD",
];

// ── "Always-include" disciplines (universal glossary) ──
const UNIVERSAL_DISCIPLINES = new Set([
  "公共卫生",
  "基础医学",
  "药理学",
]);

// ── Translation cache ──
// Key: `${raw}|${langfrom}|${langto}|${model}`, Value: translated text
// Persisted across session via Zotero prefs, max 200 entries
const CACHE_PREF_KEY = "medicalTranslator.cache";
const MAX_CACHE_ENTRIES = 200;

interface CacheEntry {
  result: string;
  timestamp: number;
}

function loadCache(): Map<string, CacheEntry> {
  try {
    const raw = getPref(CACHE_PREF_KEY) as string;
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    const map = new Map<string, CacheEntry>();
    for (const [k, v] of Object.entries(parsed)) {
      map.set(k, v as CacheEntry);
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveCache(cache: Map<string, CacheEntry>): void {
  try {
    // Trim oldest entries if over limit
    if (cache.size > MAX_CACHE_ENTRIES) {
      const sorted = [...cache.entries()]
        .sort(([, a], [, b]) => a.timestamp - b.timestamp);
      for (const [k] of sorted.slice(0, cache.size - MAX_CACHE_ENTRIES)) {
        cache.delete(k);
      }
    }
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of cache) {
      obj[k] = v;
    }
    // Use Zotero.Prefs.set directly to handle large JSON
    Zotero.Prefs.set(`extensions.zotero.ZoteroPDFTranslate.${CACHE_PREF_KEY}`, JSON.stringify(obj), true);
  } catch {
    // Cache persistence failed silently — non-critical
  }
}

// ── Custom glossary ──
function loadCustomGlossary(): Map<string, string> {
  try {
    const raw = (getPref("medicalTranslator.customGlossary") as string) || "";
    if (!raw.trim()) return new Map();
    const map = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
      // Parse: English term / abbreviation → Chinese translation
      // Supported formats: "STEMI → ST段抬高型心肌梗死" or "STEMI:ST段抬高型心肌梗死" or "STEMI,ST段抬高型心肌梗死"
      const parts = trimmed.split(/\s*[:：=→>,-]\s*/);
      if (parts.length >= 2) {
        const en = parts[0].trim();
        const cn = parts.slice(1).join(":").trim(); // Re-join in case of ":" in CN text
        if (en && cn) {
          map.set(en, cn);
          map.set(en.toLowerCase(), cn); // case-insensitive alias
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// Runtime cache (refreshed from prefs on each module load)
const translationCache = loadCache();

/**
 * Extract paper context (title + abstract + notes) for term matching.
 */
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

    const attachments = topItem.getAttachments();
    if (attachments) {
      for (const attId of attachments) {
        if (parts.length >= 5) break;
        try {
          const att = Zotero.Items.get(attId);
          if (att && att.isNote()) {
            const noteText = att.getNote();
            if (noteText) {
              const cleanText = noteText.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
              if (cleanText && cleanText.length > 50) {
                parts.push(cleanText);
              }
            }
          }
        } catch {
          // Skip invalid attachments
        }
      }
    }

    return parts.join("\n\n").slice(0, 30000);
  } catch {
    return "";
  }
}

/**
 * Pure local classification: score each major discipline by counting how many
 * of its abbreviation terms appear in the text. No API call, zero latency,
 * zero cost. Falls back to discipline "全科" when no clear signal.
 *
 * Uses keyword-frequency heuristic: for each major discipline, we count how
 * many of its abbreviations appear in the combined source + context text,
 * then pick the top 1-3 disciplines.
 *
 * Bonus: also matches Chinese discipline keywords (like "泌尿" → "泌尿外科")
 * against the text to boost the signal for non-abbreviation-rich papers.
 */
function classifyPaperLocal(
  sourceText: string,
  paperContext: string,
): string[] {
  const searchPool = (sourceText + " " + paperContext).toUpperCase();
  const searchPoolLower = (sourceText + " " + paperContext).toLowerCase();

  // Chinese discipline keyword triggers (appear in title/abstract often)
  const CN_DISC_KEYWORDS: Record<string, string[]> = {
    "心血管系统": ["心血管", "心脏", "冠状动脉", "心肌", "血压", "血管", "动脉", "静脉"],
    "呼吸系统": ["呼吸", "肺", "支气管", "哮喘", "慢阻肺", "COPD", "肺炎", "结核"],
    "消化系统": ["消化", "胃", "肝", "胆", "肠", "胰腺", "食管", "结肠", "直肠"],
    "肾脏与泌尿": ["肾", "泌尿", "膀胱", "前列腺", "透析", "尿液", "尿道"],
    "内分泌与代谢": ["内分泌", "糖尿病", "甲状腺", "代谢", "胰岛素", "血糖"],
    "血液系统": ["血液", "贫血", "白血病", "淋巴瘤", "骨髓", "血小板", "凝血"],
    "神经与精神": ["神经", "脑", "癫痫", "痴呆", "帕金森", "精神", "抑郁", "焦虑"],
    "肿瘤": ["肿瘤", "癌", "化疗", "放疗", "靶向", "免疫治疗", "转移"],
    "感染与免疫": ["感染", "病毒", "细菌", "抗生素", "免疫", "疫苗", "传染"],
    "儿科": ["儿童", "小儿", "新生儿", "婴儿", "幼儿", "先天"],
    "妇产科": ["妇", "产", "子宫", "卵巢", "妊娠", "胎儿", "宫颈"],
    "眼科": ["眼", "视网膜", "角膜", "白内障", "青光", "视力"],
    "耳鼻喉科": ["耳", "鼻", "喉", "听力", "中耳", "鼻窦"],
    "皮肤科": ["皮肤", "皮疹", "湿疹", "银屑", "荨麻疹", "黑色素"],
    "骨科": ["骨", "关节", "骨折", "脊柱", "椎", "韧带", "肌腱"],
    "麻醉与急重症": ["麻醉", "急诊", "重症", "ICU", "创伤", "休克"],
    "影像与病理": ["影像", "CT", "MRI", "超声", "病理", "活检", "X线"],
    "药理学": ["药物", "药代", "剂量", "给药", "代谢物", "不良反应"],
    "基础医学": ["基因", "细胞", "蛋白", "分子", "信号", "受体", "酶", "DNA", "RNA"],
    "公共卫生": ["统计", "流行", "队列", "随机", "meta", "风险", "发病率", "死亡率"],
  };

  // Score each discipline
  const scores: Record<string, number> = {};
  for (const disc of MAJOR_DISCIPLINES) {
    let score = 0;

    // 1. Abbreviation hits in the text
    for (const [abbr] of SORTED_ABBREVIATIONS) {
      const abbrDiscs = ABBREVIATION_DISCIPLINES.get(abbr);
      if (!abbrDiscs || !abbrDiscs.includes(disc)) continue;

      const pattern = new RegExp(
        `\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "i",
      );
      if (pattern.test(searchPool)) {
        score += 1;
      }
    }

    // 2. Chinese keyword hits (title/abstract often use Chinese)
    const cnKeywords = CN_DISC_KEYWORDS[disc];
    if (cnKeywords) {
      for (const kw of cnKeywords) {
        if (searchPoolLower.includes(kw.toLowerCase())) {
          score += 3; // Keywords are stronger signals than abbreviation matches
        }
      }
    }

    scores[disc] = score;
  }

  // Find top disciplines with meaningful scores
  const ranked = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a);

  if (ranked.length === 0) return [];

  // Take top 1-3 disciplines (only those within 50% of the top score)
  const topScore = ranked[0][1];
  const threshold = Math.max(topScore * 0.5, 2);
  const selected = ranked
    .filter(([, s]) => s >= threshold)
    .slice(0, 3)
    .map(([d]) => d);

  return selected;
}

/**
 * Find matching abbreviations — discipline-first matching.
 *
 * When disciplines are detected: ONLY include abbreviations that belong
 * to those disciplines AND appear in the text. This is the key speed
 * optimization: by eliminating unrelated disciplines' terms from the
 * prompt, we reduce token count drastically.
 *
 * When no discipline is detected: fall back to the standard text-based
 * matching (every abbreviation that appears in the text).
 */
function findMatchingAbbreviations(
  sourceText: string,
  paperContext: string,
  disciplines: string[],
): Array<[string, readonly [string, string]]> {
  const searchPool = paperContext
    ? sourceText.toUpperCase() + " " + paperContext.toUpperCase()
    : sourceText.toUpperCase();

  // When disciplines are detected, only collect abbreviations from those disciplines
  // PLUS always include terms from universal disciplines (公共卫生, 基础医学, 药理学)
  const disciplineAbbrs = new Set<string>();
  if (disciplines.length > 0) {
    const selectedDiscs = [...disciplines, ...UNIVERSAL_DISCIPLINES];
    for (const disc of selectedDiscs) {
      for (const [abbr] of SORTED_ABBREVIATIONS) {
        const abbrDiscs = ABBREVIATION_DISCIPLINES.get(abbr);
        if (abbrDiscs && abbrDiscs.includes(disc)) {
          disciplineAbbrs.add(abbr);
        }
      }
    }
  }

  const matches: Array<[string, readonly [string, string]]> = [];

  for (const [abbr, entry] of SORTED_ABBREVIATIONS) {
    const pattern = new RegExp(
      `\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    );

    if (!pattern.test(searchPool)) continue;

    // Discipline mode: only include if it belongs to one of the detected disciplines
    if (disciplines.length > 0) {
      if (disciplineAbbrs.has(abbr)) {
        matches.push([abbr, entry]);
      }
      // Skip abbreviations that don't belong to any detected discipline
    } else {
      // Fallback: include any abbreviation that appears in the text
      matches.push([abbr, entry]);
    }

    if (matches.length >= 200) break;
  }

  if (matches.length === 0) {
    return SORTED_ABBREVIATIONS.filter(([abbr]) => CORE_TERMS.includes(abbr));
  }

  return matches;
}

/**
 * Find matching vocabulary — discipline-first matching.
 *
 * Same approach: when disciplines are detected, only include vocabulary
 * terms that belong to those disciplines AND appear in the text.
 */
function findMatchingVocabulary(
  sourceText: string,
  paperContext: string,
  disciplines: string[],
): Array<[string, string]> {
  const searchPool = paperContext
    ? sourceText.toLowerCase() + " " + paperContext.toLowerCase()
    : sourceText.toLowerCase();

  const disciplineVocab = new Set<string>();
  if (disciplines.length > 0) {
    const selectedDiscs = [...disciplines, ...UNIVERSAL_DISCIPLINES];
    for (const disc of selectedDiscs) {
      for (const [en] of SORTED_VOCABULARY) {
        const vocabDiscs = VOCABULARY_DISCIPLINES.get(en);
        if (vocabDiscs && vocabDiscs.includes(disc)) {
          disciplineVocab.add(en);
        }
      }
    }
  }

  const matches: Array<[string, string]> = [];

  for (const [en, cn] of SORTED_VOCABULARY) {
    if (!(en.includes(" ") || en.length > 4)) continue;
    if (!searchPool.includes(en)) continue;

    if (disciplines.length > 0) {
      if (disciplineVocab.has(en)) {
        matches.push([en, cn]);
      }
    } else {
      matches.push([en, cn]);
    }

    if (matches.length >= 100) break;
  }

  if (matches.length === 0) {
    return SORTED_VOCABULARY.slice(0, 50);
  }

  return matches;
}

/**
 * Build the system prompt with discipline-filtered glossary terms.
 */
function buildSystemPrompt(
  sourceText: string,
  paperContext: string,
  disciplines: string[],
  customGlossary: Map<string, string>,
): string {
  const matchedAbbrs = findMatchingAbbreviations(sourceText, paperContext, disciplines);
  const matchedVocab = findMatchingVocabulary(sourceText, paperContext, disciplines);

  let termRef = matchedAbbrs
    .map(([abbr, [fullEn, fullCn]]) => `${abbr}: ${fullEn} -> ${fullCn}`)
    .join("\n");

  let vocabRef = matchedVocab
    .map(([en, cn]) => `${en} -> ${cn}`)
    .join("\n");

  // Inject custom glossary entries at the top — these take priority
  if (customGlossary.size > 0) {
    const customRef = Array.from(customGlossary.entries())
      .filter(([k]) => k === k.toUpperCase() || k.includes(" ")) // abbr or multi-word
      .slice(0, 100)
      .map(([en, cn]) => `${en} -> ${cn}`)
      .join("\n");
    if (customRef) {
      termRef = `【用户自定义术语（最高优先级）】\n${customRef}\n\n【系统词库】\n${termRef}`;
    }
  }

  const discInfo = disciplines.length > 0
    ? `\n\n当前文献已自动识别为：${disciplines.join("、")}相关领域。请优先使用该领域的标准术语。`
    : "";

  const contextIntro = paperContext
    ? `\n\n以下为当前文献的全文上下文，用于理解术语含义（非原文，仅用于术语辅助匹配）：\n${paperContext.slice(0, 1000)}`
    : "";

  return `你是一位资深医学翻译专家，专门为医学院校学生、临床规培医师和科研初学者服务。

你的核心任务：将英文医学文献翻译为中文，严格遵循以下规则：

1. **术语标准化**：优先使用《医学主题词表》(MeSH/CMeSH)中的标准译名。${discInfo}

以下是文中涉及的医学缩写对照参考（已自动匹配原文及全文中出现的术语）：
${termRef}

以下是文中涉及的通用医学术语对照参考：
${vocabRef}
${contextIntro}

2. **缩写处理**：翻译中遇到的医学缩写，使用格式【缩写：英文全称，中文全称】标注。

3. **学术严谨性**：
   - 不添加原文没有的信息
   - 不删减原文内容
   - 不曲解原文含义
   - 保持段落的逻辑结构

4. **首次出现术语**：对专业术语首次出现时，在括号中附简要中文解释。

5. **罕见术语**：对于新的或罕见的术语，给出参考译名并标注「译名供参考」。

6. 输出格式：逐段翻译，段落之间用空行分隔。先给出翻译结果，再在末尾列出「关键术语注释」部分。`;
}

/**
 * Post-process: check abbreviation translation consistency with glossary.
 */
function postProcessAbbreviationConsistency(
  resultText: string,
  matchedAbbrs: Array<[string, readonly [string, string]]>,
  customGlossary: Map<string, string>,
): string {
  let corrected = resultText;

  // ── Step 1: Force-apply custom glossary replacements ──
  // Custom glossary takes absolute priority — if the user explicitly provided
  // a translation, we apply it directly to the output text.
  if (customGlossary.size > 0) {
    for (const [en, customCn] of customGlossary) {
      // For abbreviation-style entries (all caps): replace "[ABBR: ...]" patterns
      if (en === en.toUpperCase() && en.length <= 10) {
        const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Replace "【ABBR：..."  or "ABBR：" patterns
        const bracketPattern = new RegExp(
          `【${escaped}[：:][^】]*】`,
          "gi",
        );
        corrected = corrected.replace(bracketPattern, `【${en}：${customCn}】`);
        // Also replace bare "ABBR：translation" patterns
        const barePattern = new RegExp(
          `(?<![A-Za-z])${escaped}[：:]\\s*[\\u4e00-\\u9fff]{2,20}`,
          "gi",
        );
        corrected = corrected.replace(barePattern, `${en}：${customCn}`);
      }
      // For vocabulary-style entries (multi-word English): replace Chinese term
      if (en.includes(" ") || en.length > 4) {
        // Find the default translation from our glossary
        const defaultCn = MEDICAL_VOCABULARY.get(en.toLowerCase());
        if (defaultCn && defaultCn !== customCn) {
          // Replace the default Chinese term with the custom one
          const escaped = defaultCn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          corrected = corrected.replace(new RegExp(escaped, "g"), customCn);
        }
      }
    }
  }

  // ── Step 2: Consistency check against glossary ──
  const corrections: string[] = [];

  for (const [abbr, [fullEn, standardCn]] of matchedAbbrs) {
    // Skip if custom glossary already handled this
    if (customGlossary.has(abbr) || customGlossary.has(abbr.toLowerCase())) continue;

    const abbrEscaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `${abbrEscaped}([\\s\\S]{0,80}?)([\\u4e00-\\u9fff]{2,20})`,
      "gi",
    );

    let match;
    while ((match = pattern.exec(corrected)) !== null) {
      const foundChinese = match[2];
      if (foundChinese !== standardCn && !foundChinese.includes(standardCn)) {
        const isReasonable = standardCn.includes(foundChinese) || foundChinese.includes(standardCn);
        if (!isReasonable) {
          corrections.push(`${abbr}：AI 译为「${foundChinese}」，词库标准译名为「${standardCn}」`);
        }
      }
    }
  }

  if (corrections.length > 0) {
    const uniqueCorrections = [...new Set(corrections)];
    corrected +=
      "\n\n---\n📋 **术语一致性检查**（以下术语的 AI 翻译与词库标准译名存在差异，请人工判断）：\n" +
      uniqueCorrections.map((c) => `- ${c}`).join("\n");
  }

  return corrected;
}

// ── Stream parsing helpers ──
interface ParsedResponse {
  content: string;
  finished: boolean;
}

function parseStreamResponse(obj: any): ParsedResponse {
  if (obj.choices && obj.choices[0]) {
    const choice = obj.choices[0];
    return {
      content: choice.delta?.content || "",
      finished:
        choice.finish_reason !== undefined && choice.finish_reason !== null,
    };
  }
  return { content: "", finished: false };
}

function parseNonStreamResponse(obj: any): string {
  if (obj.choices && obj.choices[0]) {
    return obj.choices[0].message.content || "";
  }
  return "";
}

// ── Main translate function ──
async function translate(
  data: Parameters<TranslateService["translate"]>[0],
): Promise<void> {
  const apiURL =
    (getPref("medicalTranslator.endPoint") as string) ||
    "https://api.deepseek.com/v1/chat/completions";
  const model =
    (getPref("medicalTranslator.model") as string) || "deepseek-v4-pro";
  const temperature = parseFloat(
    (getPref("medicalTranslator.temperature") as string) || "0.3",
  );
  const stream = (getPref("medicalTranslator.stream") as boolean) ?? true;

  // ── Step 0: Check translation cache ──
  // Cache key: raw text + language pair + model (temperature-insensitive for hit rate)
  const cacheKey = `${data.raw}|${data.langfrom || "en"}|${data.langto || "zh-CN"}|${model}`;
  const cached = translationCache.get(cacheKey);
  if (cached) {
    cached.timestamp = Date.now();
    data.result = cached.result;
    data.status = "success";
    return;
  }

  const refreshHandler = addon.api.getTemporaryRefreshHandler({ task: data });

  if (stream === false) {
    data.result = getString("status-translating");
    refreshHandler();
  }

  // Step 1: Extract paper context and load glossaries
  const paperContext = getPaperContext(data.itemId);

  // Step 1.5: Load custom glossary
  const customGlossary = loadCustomGlossary();

  // Step 2: Classify paper discipline using PURE LOCAL keyword-scoring (no API, zero latency)
  const disciplines = classifyPaperLocal(data.raw, paperContext);

  // Step 3: Build prompt with discipline-filtered glossary + custom glossary
  const systemPrompt = buildSystemPrompt(data.raw, paperContext, disciplines, customGlossary);
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
          const { content, finished } = parseStreamResponse(obj);

          result += content;
          if (finished) break;
        } catch {
          if (i === dataArray.length - 1) {
            buffer = "data:" + chunk;
          }
          continue;
        }
      }

      if (e.target.timeout) {
        e.target.timeout = 0;
      }

      data.result = result.replace(/^\n\n/, "");
      preLength = e.target.response.length;
      refreshHandler();
    };
  };

  // ── Non-streaming callback ──
  const nonStreamCallback = (xmlhttp: XMLHttpRequest) => {
    xmlhttp.onload = () => {
      try {
        const responseObj = JSON.parse(xmlhttp.responseText);
        const resultContent = parseNonStreamResponse(responseObj);
        data.result = resultContent.replace(/^\n\n/, "");
      } catch {
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
      if (stream) {
        streamCallback(xmlhttp);
      } else {
        nonStreamCallback(xmlhttp);
      }
    },
  });

  if (xhr?.status !== 200) {
    data.status = "fail";
    throw `Request error: ${xhr?.status}`;
  }

  // Step 4: Post-process consistency check + custom glossary enforcement
  const matchedAbbrs = findMatchingAbbreviations(data.raw, paperContext, disciplines);
  data.result = postProcessAbbreviationConsistency(data.result, matchedAbbrs, customGlossary);

  // Step 5: Save to translation cache
  translationCache.set(cacheKey, { result: data.result, timestamp: Date.now() });
  saveCache(translationCache);

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
        min: 0,
        max: 2,
        step: 0.1,
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
MACE → 主要心血管不良事件
PCI → 经皮冠状动脉介入治疗
myocardial infarction → 心肌梗死`,
      });
  },
};
