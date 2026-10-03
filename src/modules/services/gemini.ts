import { getPref, transformPromptWithContext } from "../../utils";
import { TranslateService } from "./base";
import { createSSEParser } from "../../utils/sse";

function parseGeminiResponse(responseText: string) {
  const responseObj = JSON.parse(responseText);
  if (responseObj.error) {
    throw new Error(
      `API error: ${responseObj.error.message || "unknown error"}`,
    );
  }
  if (responseObj.promptFeedback?.blockReason) {
    throw new Error(`API error: ${responseObj.promptFeedback.blockReason}`);
  }
  const candidate = responseObj.candidates?.[0];
  const reason = candidate?.finishReason;
  if (reason && reason !== "STOP") {
    throw new Error(`API error: incomplete translation (${reason})`);
  }
  return {
    content: (candidate?.content?.parts || [])
      .filter((part: any) => !part.thought)
      .map((part: any) => part.text || "")
      .join(""),
    finished: reason === "STOP",
  };
}

const translate = <TranslateService["translate"]>async function (data) {
  const apiURL = getPref("gemini.endPoint") as string;
  const stream = getPref("gemini.stream") as boolean;

  function transformContent(
    langFrom: string,
    langTo: string,
    sourceText: string,
  ) {
    return transformPromptWithContext(
      "gemini.prompt",
      langFrom,
      langTo,
      sourceText,
      data,
    );
  }

  const refreshHandler = addon.api.getTemporaryRefreshHandler({ task: data });
  let preLength = 0;
  let result = "";
  let finished = false;
  let parseError: Error | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const parser = createSSEParser((payload) => {
    if (parseError || payload.trim() === "[DONE]") return;
    try {
      const parsed = parseGeminiResponse(payload);
      result += parsed.content;
      finished ||= parsed.finished;
    } catch (error) {
      parseError =
        error instanceof Error
          ? error
          : new Error("API error: invalid response");
    }
  });
  const consumeResponse = (xmlhttp: XMLHttpRequest) => {
    parser.push(xmlhttp.responseText.slice(preLength));
    preLength = xmlhttp.responseText.length;
    data.result = result;
    if (!refreshTimer) {
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        refreshHandler();
      }, 50);
    }
  };

  try {
    const xhr = await Zotero.HTTP.request(
      "POST",
      apiURL + (stream ? ":streamGenerateContent?alt=sse" : ":generateContent"),
      {
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": data.secret,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: transformContent(data.langfrom, data.langto, data.raw),
                },
              ],
            },
          ],
        }),
        responseType: "text",
        timeout: 120000,
        errorDelayMax: 0,
        requestObserver: (xmlhttp: XMLHttpRequest) => {
          if (stream) xmlhttp.onprogress = () => consumeResponse(xmlhttp);
        },
      },
    );
    if (xhr?.status !== 200) {
      throw new Error(`Request error: ${xhr?.status}`);
    }
    if (stream) {
      consumeResponse(xhr);
      parser.finish();
      if (parseError) throw parseError;
      if (!finished)
        throw new Error("API error: interrupted translation stream");
    } else {
      result = parseGeminiResponse(xhr.responseText).content;
    }
    if (!result.trim()) throw new Error("API error: empty response");
    data.result = result;
    data.status = "success";
  } catch (error) {
    data.status = "fail";
    throw error;
  } finally {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshHandler();
  }
};

export const Gemini: TranslateService = {
  id: "gemini",
  type: "sentence",
  helpUrl: "https://ai.google.dev/gemini-api/docs",

  defaultSecret: "",
  secretValidator(secret: string) {
    const flag = Boolean(secret);
    return {
      secret,
      status: flag,
      info: flag ? "" : "The secret is not set.",
    };
  },

  translate,

  config(settings) {
    settings
      .addTextSetting({
        prefKey: "gemini.endPoint",
        nameKey: "service-gemini-dialog-endPoint",
      })
      .addTextAreaSetting({
        prefKey: "gemini.prompt",
        nameKey: "service-gemini-dialog-prompt",
      })
      .addCheckboxSetting({
        prefKey: "gemini.stream",
        nameKey: "service-gemini-dialog-stream",
      });
  },
};
