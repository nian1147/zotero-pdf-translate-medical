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
 * Classify the paper's medical discipline using a lightweight LLM call.
 * Returns a list of discipline names from MAJOR_DISCIPLINES.
 */
async function classifyPaperDiscipline(
  sourceText: string,
  paperContext: string,
  apiURL: string,
  secret: string,
  model: string,
): Promise<string[]> {
  const sampleText = sourceText.slice(0, 500) + (paperContext ? "\n\n" + paperContext.slice(0, 1000) : "");
  const disciplineList = MAJOR_DISCIPLINES.join("、");

  const classifyPrompt = `请根据以下医学文献片段，判断其所属的学科分类（可多选，最多3个）。

可选学科列表：${disciplineList}

只输出学科名称，用逗号分隔，不要任何解释。

文献内容：
${sampleText}

学科分类：`;

  try {
    const xhr = await Zotero.HTTP.request("POST", apiURL, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: classifyPrompt }],
        temperature: 0.1,
        max_tokens: 50,
        stream: false,
      }),
      responseType: "json",
    });

    if (xhr?.status !== 200) return [];

    const content = xhr.response?.choices?.[0]?.message?.content || "";
    const detected = content
      .split(/[,，、]/)
      .map((d: string) => d.trim())
      .filter((d: string) => MAJOR_DISCIPLINES.includes(d));

    return detected;
  } catch {
    return [];
  }
}

/**
 * Find matching abbreviations — discipline-filtered + text-matched.
 */
function findMatchingAbbreviations(
  sourceText: string,
  paperContext: string,
  disciplines: string[],
): Array<[string, readonly [string, string]]> {
  const searchPool = paperContext
    ? sourceText.toUpperCase() + " " + paperContext.toUpperCase()
    : sourceText.toUpperCase();

  // Collect abbreviations from matching disciplines
  const disciplineAbbrs = new Set<string>();
  if (disciplines.length > 0) {
    for (const disc of disciplines) {
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

    if (pattern.test(searchPool)) {
      if (disciplineAbbrs.size === 0 || disciplineAbbrs.has(abbr)) {
        matches.push([abbr, entry]);
      }
    }
    if (matches.length >= 200) break;
  }

  if (matches.length === 0) {
    return SORTED_ABBREVIATIONS.filter(([abbr]) => CORE_TERMS.includes(abbr));
  }

  return matches;
}

/**
 * Find matching vocabulary — discipline-filtered + text-matched.
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
    for (const disc of disciplines) {
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
    if ((en.includes(" ") || en.length > 4) && searchPool.includes(en)) {
      if (disciplineVocab.size === 0 || disciplineVocab.has(en)) {
        matches.push([en, cn]);
      }
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
): string {
  const matchedAbbrs = findMatchingAbbreviations(sourceText, paperContext, disciplines);
  const matchedVocab = findMatchingVocabulary(sourceText, paperContext, disciplines);

  const termRef = matchedAbbrs
    .map(([abbr, [fullEn, fullCn]]) => `${abbr}: ${fullEn} -> ${fullCn}`)
    .join("\n");

  const vocabRef = matchedVocab
    .map(([en, cn]) => `${en} -> ${cn}`)
    .join("\n");

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
): string {
  let corrected = resultText;
  const corrections: string[] = [];

  for (const [abbr, [fullEn, standardCn]] of matchedAbbrs) {
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

  const refreshHandler = addon.api.getTemporaryRefreshHandler({ task: data });

  if (stream === false) {
    data.result = getString("status-translating");
    refreshHandler();
  }

  // Step 1: Extract paper context
  const paperContext = getPaperContext(data.itemId);

  // Step 2: Classify paper discipline (lightweight call) to filter glossary
  let disciplines: string[] = [];
  try {
    disciplines = await classifyPaperDiscipline(
      data.raw, paperContext, apiURL, data.secret || "", model,
    );
  } catch {
    // Classification failed silently — will use text-based matching fallback
  }

  // Step 3: Build prompt with discipline-filtered glossary
  const systemPrompt = buildSystemPrompt(data.raw, paperContext, disciplines);
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

  // Step 4: Post-process consistency check
  const matchedAbbrs = findMatchingAbbreviations(data.raw, paperContext, disciplines);
  data.result = postProcessAbbreviationConsistency(data.result, matchedAbbrs);
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
      });
  },
};
