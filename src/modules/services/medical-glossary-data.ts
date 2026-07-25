// Auto-generated medical glossary data — lazy-loaded from JSON
// Generated from terms.csv and vocabulary.csv
// DO NOT EDIT MANUALLY

// @ts-ignore - JSON import with type assertion
import glossaryJson from "./medical-glossary.json" with { type: "json" };

type AbbrEntry = [string, string];
type VocabEntry = string;
type DiscList = string[];

const data = glossaryJson as any;

export const MEDICAL_ABBREVIATIONS: ReadonlyMap<string, readonly [string, string]> =
  new Map(Object.entries(data.abr).map(([k, v]: [string, any]) => [k, [v[0], v[1]] as const]));

export const CN_TO_EN: ReadonlyMap<string, readonly [string, string]> = new Map();

export const MEDICAL_VOCABULARY: ReadonlyMap<string, string> =
  new Map(Object.entries(data.voc) as Array<[string, string]>);

export const ABBREVIATION_DISCIPLINES: ReadonlyMap<string, readonly string[]> =
  new Map(Object.entries(data.adisc).map(([k, v]: [string, any]) =>
    [k, Array.isArray(v) ? v : [v]]));

export const VOCABULARY_DISCIPLINES: ReadonlyMap<string, readonly string[]> =
  new Map(Object.entries(data.vdisc).map(([k, v]: [string, any]) =>
    [k, Array.isArray(v) ? v : [v]]));

export const MAJOR_DISCIPLINES: readonly string[] = data.discs || [];

export function initGlossaryData(): void {
  // Already initialized from JSON import — no-op
}
