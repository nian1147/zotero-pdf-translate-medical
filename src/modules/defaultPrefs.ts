import { clearPref, getPref, getPrefJSON, setPref } from "../utils/prefs";
import { services } from "./services";

export function setDefaultPrefSettings() {
  const isZhCN = Zotero.locale === "zh-CN";
  const servicesIds = services.getAllServices().map((service) => service.id);
  if (!servicesIds.includes((getPref("translateSource") as string) || "")) {
    setPref("translateSource", "medical-translator");
  }

  // Retired dictionary adapters cannot handle words after upgrading. Route all
  // text through the selected model; keep saved API keys for existing users.
  setPref("enableDict", false);
  setPref("dictSource", "");
  setPref("showPlayBtn", false);
  setPref("autoPlay", false);

  if (!getPref("targetLanguage")) {
    setPref("targetLanguage", Zotero.locale);
  }

  const secrets = getPrefJSON("secretObj");
  for (const serviceId of servicesIds) {
    if (typeof secrets[serviceId] === "undefined") {
      secrets[serviceId] =
        services.getServiceById(serviceId)!.defaultSecret || "";
    }
  }
  setPref("secretObj", JSON.stringify(secrets));

  if (isZhCN && !getPref("disabledLanguages")) {
    setPref("disabledLanguages", "zh,zh-CN,中文;");
  }

  const extraServices = ((getPref("extraEngines") as string) || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => servicesIds.includes(id))
    .join(",");
  setPref("extraEngines", extraServices);

  // From v2.3.1 to v2.3.7, Pref customGPTx.temperature has been set as number type
  // Change the type from number to string to be compatible with floating-point values
  const gptKeys = ["customGPT1", "customGPT2", "customGPT3"];

  gptKeys.forEach((key) => {
    const prefKey = `${key}.temperature`;
    const value = getPref(prefKey);

    if (value !== undefined && typeof value === "number") {
      clearPref(prefKey);
      setPref(prefKey, String(value));
    }
  });

  if (!getPref("annotationTagContent")) {
    setPref("annotationTagContent", isZhCN ? "翻译" : "Translation");
  }
}
