import { getPrefJSON, setPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { services } from "../services";

export async function manageKeysDialog() {
  const dialog = new ztoolkit.Dialog(2, 1);
  const secrets = getPrefJSON("secretObj");
  const modelServices = services.getAllServices();
  const modelSecrets = Object.fromEntries(
    modelServices.map((service) => [service.id, secrets[service.id] || ""]),
  );

  const dialogData: {
    secrets: string;
    updateSuccess: boolean;
    unloadLock?: any;
    _lastButtonId?: string;
  } = {
    secrets: JSON.stringify(modelSecrets, null, 2),
    updateSuccess: false,
  };

  dialog
    .setDialogData(dialogData)
    .addCell(
      0,
      0,
      {
        tag: "div",
        namespace: "html",
        styles: {
          display: "flex",
          flexDirection: "column",
          gap: "15px",
          padding: "20px",
        },
        children: [
          {
            tag: "label",
            namespace: "html",
            properties: {
              innerHTML: getString("service-manageKeys-head"),
            },
            styles: {
              marginBottom: "5px",
            },
          },
          {
            tag: "textarea",
            namespace: "html",
            attributes: {
              "data-bind": "secrets",
              "data-prop": "value",
              rows: "25",
              cols: "70",
            },
            styles: {
              fontFamily: "monospace",
              whiteSpace: "pre",
              overflowX: "auto",
              padding: "8px",
            },
          },
        ],
      },
      false,
    )
    .addButton(getString("service-manageKeys-close"), "close")
    .addButton(getString("service-manageKeys-save"), "save", {
      callback: () => {
        const textarea = dialog.window?.document.querySelector(
          `textarea[data-bind="secrets"]`,
        ) as HTMLTextAreaElement | null;
        if (textarea) {
          dialogData.secrets = textarea.value;
        }
      },
    })
    .open(getString("service-manageKeys-title"));

  if (dialogData.unloadLock && dialogData.unloadLock.promise) {
    try {
      await dialogData.unloadLock.promise;
    } catch (error) {
      console.error("Error waiting for dialog to close:", error);
    }
  }

  if (dialogData._lastButtonId === "save") {
    try {
      const parsedSecrets = JSON.parse(dialogData.secrets);
      if (
        !parsedSecrets ||
        typeof parsedSecrets !== "object" ||
        Array.isArray(parsedSecrets)
      ) {
        throw new Error(
          "Keys must be a JSON object of AI service IDs and strings.",
        );
      }
      for (const [id, key] of Object.entries(parsedSecrets)) {
        if (!services.getServiceById(id) || typeof key !== "string") {
          throw new Error(`Invalid AI service or key format: ${id}`);
        }
      }
      // Retired keys stay stored for rollback, but are absent from the editor.
      const updatedSecrets = getPrefJSON("secretObj");
      for (const service of modelServices) {
        updatedSecrets[service.id] = parsedSecrets[service.id] || "";
      }
      setPref("secretObj", JSON.stringify(updatedSecrets));
      dialogData.updateSuccess = true;

      // Refresh UI if needed
      addon.hooks.onReaderTabPanelRefresh();
    } catch (e) {
      if (dialog.window) {
        Zotero.alert(
          dialog.window,
          "Error",
          `Failed to save keys: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return dialogData.updateSuccess;
}
