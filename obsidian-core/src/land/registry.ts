/**
 * Obsidian Circle geographic registry.
 *
 * The protocol needs two deterministic facts about a location:
 *   1. the administrative hierarchy (earth -> continent -> country -> region ->
 *      city -> district -> street -> parcel), used for search and for parcel
 *      identity; and
 *   2. the initial GLV (Global Location Value) of every first-level division,
 *      which is the price of the first protocol purchase there.
 *
 * Initial GLV is derived from a published factor table with deterministic
 * integer arithmetic, bounded by the protocol minimum (0.01 OBS) and maximum
 * (5 OBS) from CONSENSUS_PARAMS.circle:
 *
 *   GLV = clamp(min, base(population, economy, infrastructure, tourism,
 *                globalSignificance) * countryMultiplier, max)
 *
 * Every node ships the same table (src/land/geography.ts, changeable only by a
 * protocol version bump), so every node derives identical prices. Nothing here
 * reads the network or an external service.
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { minBig, maxBig } from '../protocol/amount.js';
import { sha256Hex, utf8 } from '../crypto/hash.js';
import { GEOGRAPHY } from './geography.js';

const geography: GeographyFile = GEOGRAPHY;

export const DIVISION_LEVEL_CODES = {
  DIVISION: 1,
  CITY: 2,
  DISTRICT: 3,
  STREET: 4,
} as const;

export type DivisionLevel = keyof typeof DIVISION_LEVEL_CODES;

export interface CountryEntry {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  continent: string;
  /** Population in millions, integer (published reference values). */
  populationM: number;
  /** Economic activity index 0-100 (relative GDP weight). */
  economy: number;
  /** Infrastructure index 0-100. */
  infrastructure: number;
  /** Tourism index 0-100. */
  tourism: number;
  /** Global significance index 0-100 (cultural / political weight). */
  significance: number;
  /**
   * ISO 3166-2 first-level divisions. When omitted the country itself is the
   * first-level division (city-states and single-tier territories).
   */
  divisions?: Array<{ id: string; name: string; weight?: number }>;
}

export interface GeographyFile {
  version: string;
  countries: CountryEntry[];
}

export function geographyTable(): GeographyFile {
  return geography;
}

export function normaliseDivisionId(divisionId: string): string {
  return divisionId.trim().toUpperCase();
}

export function findDivision(divisionId: string): { country: CountryEntry; divisionId: string; weight: number } | null {
  const id = normaliseDivisionId(divisionId);
  const countryCode = id.slice(0, 2);
  const country = geography.countries.find((c) => c.code === countryCode);
  if (!country) return null;
  if (id === countryCode) return { country, divisionId: id, weight: 1 };
  const division = country.divisions?.find((d) => normaliseDivisionId(d.id) === id);
  if (!division) return null;
  return { country, divisionId: id, weight: division.weight ?? 1 };
}

/**
 * Base GLV for a location, in OBS seals, from the published factor table.
 * Deterministic integer expression — no floating point in consensus, and no
 * external price source of any kind.
 */
export function baseGlv(country: CountryEntry, divisionWeight = 1): bigint {
  // Factors are 0-100 indices; the weights below sum to 100.
  const populationFactor = BigInt(Math.min(100, Math.round(country.populationM * 1.2))); // 0-100, saturating at 83M+
  const economyFactor = BigInt(Math.max(0, Math.min(100, country.economy)));
  const infrastructureFactor = BigInt(Math.max(0, Math.min(100, country.infrastructure)));
  const tourismFactor = BigInt(Math.max(0, Math.min(100, country.tourism)));
  const significanceFactor = BigInt(Math.max(0, Math.min(100, country.significance)));

  // Weighted index in tenths of a point, 0-1000.
  const weighted =
    populationFactor * 30n +
    economyFactor * 30n +
    infrastructureFactor * 15n +
    tourismFactor * 10n +
    significanceFactor * 15n; // 0..10_000

  // Map the index onto the protocol's OBS band: index 0 -> minGlv,
  // index 10_000 -> maxGlv, then apply the division weight (percent) and clamp.
  const minSeals = CONSENSUS_PARAMS.circle.minGlv;
  const maxSeals = CONSENSUS_PARAMS.circle.maxGlv;
  const range = maxSeals - minSeals;
  const scaled = (weighted * range) / 10_000n;
  let value = minSeals + scaled;
  if (divisionWeight !== 1) {
    value = (value * BigInt(Math.round(divisionWeight * 100))) / 100n;
  }
  return minBig(maxBig(value, CONSENSUS_PARAMS.circle.minGlv), CONSENSUS_PARAMS.circle.maxGlv);
}

export interface DivisionSeed {
  divisionId: string;
  countryCode: string;
  countryName: string;
  continent: string;
  glvSeals: bigint;
  /** Deterministic identity for the division record. */
  fingerprint: string;
}

export function divisionSeed(divisionId: string, countryCode?: string): DivisionSeed {
  const id = normaliseDivisionId(divisionId);
  const found = findDivision(id);
  if (!found) {
    // Unknown divisions are still supported (the protocol must not require an
    // ever-growing hardcoded table), but they take the protocol minimum GLV so
    // an unregistered location can never be priced above a real one.
    return {
      divisionId: id,
      countryCode: countryCode ?? id.slice(0, 2),
      countryName: 'Unknown',
      continent: 'Unknown',
      glvSeals: CONSENSUS_PARAMS.circle.minGlv,
      fingerprint: sha256Hex(utf8(`DIVISION|${id}|unknown`)).slice(0, 24),
    };
  }
  return {
    divisionId: id,
    countryCode: found.country.code,
    countryName: found.country.name,
    continent: found.country.continent,
    glvSeals: baseGlv(found.country, found.weight),
    fingerprint: sha256Hex(utf8(`DIVISION|${id}|${found.country.name}`)).slice(0, 24),
  };
}

export interface SearchHit {
  divisionId: string;
  countryCode: string;
  name: string;
  continent: string;
  glvSeals: bigint;
  glvObs: string;
}

/** Simple, deterministic, case-insensitive search over the registry. */
export function searchDivisions(query: string, limit = 25): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const country of geography.countries) {
    const add = (divisionId: string, name: string, weight = 1): void => {
      const glv = baseGlv(country, weight);
      hits.push({
        divisionId,
        countryCode: country.code,
        name: `${name}, ${country.name}`,
        continent: country.continent,
        glvSeals: glv,
        glvObs: glv.toString(),
      });
    };
    if (
      country.name.toLowerCase().includes(needle) ||
      country.code.toLowerCase() === needle
    ) {
      if (!country.divisions || country.divisions.length === 0) add(country.code, country.name);
    }
    for (const division of country.divisions ?? []) {
      if (division.name.toLowerCase().includes(needle) || division.id.toLowerCase() === needle) {
        add(division.id, division.name, division.weight ?? 1);
      }
    }
    if (hits.length >= limit * 3) break;
  }
  return hits.slice(0, limit);
}

/**
 * Every first-level division of one country, with the GLV the protocol gives it.
 *
 * `listCountries()` returns counts only, so an interface that wanted to offer
 * Earth → country → division navigation had to guess division ids. This is the
 * registry, not chain state: current GLVs come from the node's state store and
 * are overlaid by the RPC handler.
 */
export function listDivisions(countryCode: string): Array<{
  divisionId: string;
  name: string;
  weight: number;
  glvSeals: bigint;
  glvObs: string;
  level: number;
}> {
  const code = countryCode.trim().toUpperCase();
  const country = geography.countries.find((entry) => entry.code === code);
  if (!country) return [];
  const divisions = country.divisions ?? [];
  if (divisions.length === 0) {
    const glv = baseGlv(country);
    return [
      {
        divisionId: country.code,
        name: country.name,
        weight: 1,
        glvSeals: glv,
        glvObs: glv.toString(),
        level: 1,
      },
    ];
  }
  return divisions.map((division) => {
    const weight = division.weight ?? 1;
    const glv = baseGlv(country, weight);
    return {
      divisionId: normaliseDivisionId(division.id),
      name: division.name,
      weight,
      glvSeals: glv,
      glvObs: glv.toString(),
      level: 1,
    };
  });
}

export function listCountries(): Array<{
  code: string;
  name: string;
  continent: string;
  divisionCount: number;
  glvObs: string;
}> {
  return geography.countries.map((country) => ({
    code: country.code,
    name: country.name,
    continent: country.continent,
    divisionCount: country.divisions?.length ?? 1,
    glvObs: baseGlv(country).toString(),
  }));
}
