// medical-glossary-data.ts — inlined data for test/reference, NOT used at startup.
// The real data lives in addon/chrome/content/medical-glossary.json
// and is loaded asynchronously by initGlossaryData().
// This file MUST NOT import or export large static objects.

let _initialized = false;

let _MEDICAL_ABBREVIATIONS: Map<string, [string, string]> = new Map();
let _MEDICAL_VOCABULARY: Map<string, string> = new Map();
let _ABBREVIATION_DISCIPLINES: Map<string, string[]> = new Map();
let _VOCABULARY_DISCIPLINES: Map<string, string[]> = new Map();
let _MAJOR_DISCIPLINES: string[] = [];

export function initGlossaryData(): void {
  if (_initialized) return;
  _initialized = true;

  try {
    const data = getGlossaryJSON();
    if (!data) return;

    const m1 = _MEDICAL_ABBREVIATIONS;
    for (const [k, v] of Object.entries(data.abr)) {
      m1.set(k, [(v as any)[0], (v as any)[1]]);
    }

    const m2 = _MEDICAL_VOCABULARY;
    for (const [k, v] of Object.entries(data.voc)) {
      m2.set(k, v as string);
    }

    const m3 = _ABBREVIATION_DISCIPLINES;
    for (const [k, v] of Object.entries(data.adisc)) {
      m3.set(k, v as string[]);
    }

    const m4 = _VOCABULARY_DISCIPLINES;
    for (const [k, v] of Object.entries(data.vdisc)) {
      m4.set(k, v as string[]);
    }

    _MAJOR_DISCIPLINES = data.discs as string[];
  } catch (e) {
    // Silent fallback — glossary won't be loaded, translation still works
  }
}

// Export accessors that delegate to the runtime maps
export const MEDICAL_ABBREVIATIONS: ReadonlyMap<string, readonly [string, string]> = {
  get size() { return _MEDICAL_ABBREVIATIONS.size; },
  get: (k: string) => _MEDICAL_ABBREVIATIONS.get(k),
  has: (k: string) => _MEDICAL_ABBREVIATIONS.has(k),
  entries: () => _MEDICAL_ABBREVIATIONS.entries(),
  forEach: (cb: any, thisArg?: any) => _MEDICAL_ABBREVIATIONS.forEach(cb, thisArg),
  keys: () => _MEDICAL_ABBREVIATIONS.keys(),
  values: () => _MEDICAL_ABBREVIATIONS.values(),
  [Symbol.iterator]: () => _MEDICAL_ABBREVIATIONS[Symbol.iterator](),
} as ReadonlyMap<string, readonly [string, string]>;

export const CN_TO_EN: ReadonlyMap<string, readonly [string, string]> = new Map();

export const MEDICAL_VOCABULARY: ReadonlyMap<string, string> = {
  get size() { return _MEDICAL_VOCABULARY.size; },
  get: (k: string) => _MEDICAL_VOCABULARY.get(k),
  has: (k: string) => _MEDICAL_VOCABULARY.has(k),
  entries: () => _MEDICAL_VOCABULARY.entries(),
  forEach: (cb: any, thisArg?: any) => _MEDICAL_VOCABULARY.forEach(cb, thisArg),
  keys: () => _MEDICAL_VOCABULARY.keys(),
  values: () => _MEDICAL_VOCABULARY.values(),
  [Symbol.iterator]: () => _MEDICAL_VOCABULARY[Symbol.iterator](),
} as ReadonlyMap<string, string>;

export const ABBREVIATION_DISCIPLINES: ReadonlyMap<string, readonly string[]> = {
  get size() { return _ABBREVIATION_DISCIPLINES.size; },
  get: (k: string) => _ABBREVIATION_DISCIPLINES.get(k),
  has: (k: string) => _ABBREVIATION_DISCIPLINES.has(k),
  entries: () => _ABBREVIATION_DISCIPLINES.entries(),
  forEach: (cb: any, thisArg?: any) => _ABBREVIATION_DISCIPLINES.forEach(cb, thisArg),
  keys: () => _ABBREVIATION_DISCIPLINES.keys(),
  values: () => _ABBREVIATION_DISCIPLINES.values(),
  [Symbol.iterator]: () => _ABBREVIATION_DISCIPLINES[Symbol.iterator](),
} as ReadonlyMap<string, readonly string[]>;

export const VOCABULARY_DISCIPLINES: ReadonlyMap<string, readonly string[]> = {
  get size() { return _VOCABULARY_DISCIPLINES.size; },
  get: (k: string) => _VOCABULARY_DISCIPLINES.get(k),
  has: (k: string) => _VOCABULARY_DISCIPLINES.has(k),
  entries: () => _VOCABULARY_DISCIPLINES.entries(),
  forEach: (cb: any, thisArg?: any) => _VOCABULARY_DISCIPLINES.forEach(cb, thisArg),
  keys: () => _VOCABULARY_DISCIPLINES.keys(),
  values: () => _VOCABULARY_DISCIPLINES.values(),
  [Symbol.iterator]: () => _VOCABULARY_DISCIPLINES[Symbol.iterator](),
} as ReadonlyMap<string, readonly string[]>;

export const MAJOR_DISCIPLINES: readonly string[] = _MAJOR_DISCIPLINES;

// ── Internal: load the JSON data from the addon's chrome directory ──
function getGlossaryJSON(): any {
  // Try to read the JSON file bundled in the addon
  // On Zotero 7+, the file is accessible via a chrome:// URL fetched with XMLHttpRequest
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "chrome://zoteropdftranslate/content/medical-glossary.json", false);
    xhr.overrideMimeType("application/json");
    xhr.send(null);
    if (xhr.status === 200) {
      return JSON.parse(xhr.responseText);
    }
  } catch { /* fall through */ }

  // Fallback: try reading from the file system
  try {
    const path = `${Zotero.getZoteroDirectory().path}/../extensions/zoteropdftranslate@euclpts.com/chrome/content/medical-glossary.json`;
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `file:///${path.replace(/\\/g, "/")}`, false);
    xhr.overrideMimeType("application/json");
    xhr.send(null);
    if (xhr.status === 200) {
      return JSON.parse(xhr.responseText);
    }
  } catch { /* fall through */ }

  return null;
}
