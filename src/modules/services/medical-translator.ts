import { getPref, getString } from "../../utils";
import { TranslateService } from "./base";
import { MEDICAL_ABBREVIATIONS, MEDICAL_VOCABULARY } from "./medical-glossary-data";

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
 * Find which abbreviations from our glossary appear in the source text.
 * Uses case-insensitive whole-word matching.
 */
function findMatchingAbbreviations(sourceText: string): Array<[string, readonly [string, string]]> {
  const textUpper = sourceText.toUpperCase();
  const matches: Array<[string, readonly [string, string]]> = [];

  for (const [abbr, entry] of SORTED_ABBREVIATIONS) {
    // Use word-boundary regex for accurate matching
    const pattern = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(sourceText)) {
      matches.push([abbr, entry]);
    }
    if (matches.length >= 200) break; // Cap at 200 matches to prevent huge prompts
  }

  // If we found matches, return them. Otherwise include core terms as baseline.
  if (matches.length > 0) {
    return matches;
  }

  // Fallback: include high-frequency core terms
  return SORTED_ABBREVIATIONS.filter(([abbr]) => CORE_TERMS.includes(abbr));
}

/**
 * Find which vocabulary terms appear in the source text.
 */
function findMatchingVocabulary(sourceText: string): Array<[string, string]> {
  const textLower = sourceText.toLowerCase();
  const matches: Array<[string, string]> = [];

  for (const [en, cn] of SORTED_VOCABULARY) {
    // Only match multi-word terms or terms longer than 4 chars to avoid noise
    if ((en.includes(" ") || en.length > 4) && textLower.includes(en)) {
      matches.push([en, cn]);
    }
    if (matches.length >= 100) break;
  }

  // If no matches, include top 50 most common terms as baseline
  if (matches.length === 0) {
    return SORTED_VOCABULARY.slice(0, 50);
  }

  return matches;
}

/**
 * Build the system prompt with ONLY the matching glossary terms for this text.
 * This reduces the prompt from ~100K tokens to ~2-5K tokens, dramatically
 * improving response speed.
 */
function buildSystemPrompt(sourceText: string): string {
  const matchedAbbrs = findMatchingAbbreviations(sourceText);
  const matchedVocab = findMatchingVocabulary(sourceText);

  const termRef = matchedAbbrs
    .map(([abbr, [fullEn, fullCn]]) => `${abbr}: ${fullEn} -> ${fullCn}`)
    .join("\n");

  const vocabRef = matchedVocab
    .map(([en, cn]) => `${en} -> ${cn}`)
    .join("\n");

  return `你是一位资深医学翻译专家，专门为医学院校学生、临床规培医师和科研初学者服务。

你的核心任务：将英文医学文献翻译为中文，严格遵循以下规则：

1. **术语标准化**：优先使用《医学主题词表》(MeSH/CMeSH)中的标准译名。

以下是文中涉及的医学缩写对照参考（已自动匹配原文中出现的术语）：
${termRef}

以下是文中涉及的通用医学术语对照参考：
${vocabRef}

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

  // Build prompt with smart glossary matching based on source text
  const systemPrompt = buildSystemPrompt(data.raw);
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
          if (finished) {
            break;
          }
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
