// Tolerant JSON parser tuned for LLM output.
//
// Why this module exists: Qwen3.5-Flash on OpenRouter has a published
// "structured output error rate" of ~3% — roughly 1 in 33 responses
// is malformed JSON. Even with ``response_format: json_object`` forced,
// edge cases slip through: trailing commas after the last property,
// smart-quotes from the model's training data, an unterminated string
// because the model ran out of completion tokens, etc.
//
// Without this repair layer, each malformation triggers a chapter-level
// retry (30s-3min of backoff + a full re-run of the prompt). With it,
// we recover in microseconds and only retry on REAL failures (network,
// 5xx, severely corrupted output).
//
// Gemini's output is much cleaner, but Gemini calls also benefit from
// the repair pass — saves the occasional retry there too.

import { debugLog } from "./debugLog";

/**
 * Parse LLM-generated JSON with graceful recovery. Tries strict
 * ``JSON.parse`` first, then progressively more aggressive repair
 * passes. Throws only when every repair attempt fails.
 *
 * @param raw  The raw model output. Can include code fences,
 *             commentary before/after, smart quotes, trailing commas,
 *             missing closing brackets — all handled.
 * @param expectedType  ``"object"`` or ``"array"`` to disambiguate
 *             extraction when the model wrapped output in noise.
 */
export function safeJsonParse<T = unknown>(
  raw: string,
  expectedType: "object" | "array" = "object",
): T {
  const cleaned = stripCodeFences(raw);

  // FAST PATH: try strict parse on the cleaned text first. Covers the
  // ~97% case where the model gave us valid JSON.
  try {
    const r = JSON.parse(cleaned) as T;
    debugLog.push({ type: "parse-success", label: "JSON parse (strict)" });
    return r;
  } catch {
    /* fall through to recovery */
  }

  // Extract just the {...} or [...] block, ignoring leading/trailing
  // commentary the model might have added.
  const extracted =
    expectedType === "array"
      ? extractBalancedArray(cleaned)
      : extractBalancedObject(cleaned);

  // Try parse on the extracted block.
  try {
    const r = JSON.parse(extracted) as T;
    debugLog.push({
      type: "parse-repair",
      label: "JSON parse (after extracting balanced block)",
      detail: raw.slice(0, 200),
    });
    return r;
  } catch {
    /* fall through to repair */
  }

  // Apply increasingly aggressive repairs.
  const repaired = repairJson(extracted);
  try {
    const r = JSON.parse(repaired) as T;
    debugLog.push({
      type: "parse-repair",
      label: "JSON parse (after repair: smart quotes / trailing commas / etc)",
      detail: raw.slice(0, 200),
    });
    return r;
  } catch (err) {
    // Final attempt: balance brackets in case the model was truncated.
    const balanced = balanceBrackets(repaired);
    try {
      const r = JSON.parse(balanced) as T;
      debugLog.push({
        type: "parse-repair",
        label: "JSON parse (after bracket balancing — output was truncated)",
        detail: raw.slice(0, 200),
      });
      return r;
    } catch {
      debugLog.push({
        type: "parse-fail",
        label: "JSON parse failed after all repair attempts",
        detail: `Error: ${(err as Error).message}\nRaw start: ${raw.slice(0, 400)}`,
      });
      throw new Error(
        `JSON parse failed after all repair attempts: ${(err as Error).message}. ` +
          `Raw start: ${raw.slice(0, 120)}`,
      );
    }
  }
}

/**
 * Variant that returns ``null`` instead of throwing — for callers that
 * already have a sensible default for "couldn't parse" (e.g., empty
 * beats array means trigger retry).
 */
export function tryJsonParse<T = unknown>(
  raw: string,
  expectedType: "object" | "array" = "object",
): T | null {
  try {
    return safeJsonParse<T>(raw, expectedType);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json|JSON)?\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();
}

/** Find the first balanced ``{...}`` block, tracking string state. */
function extractBalancedObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return text;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Unclosed — return what we have so the caller can try to repair.
  return text.slice(start);
}

/** Find the first balanced ``[...]`` block, tracking string state. */
function extractBalancedArray(text: string): string {
  const start = text.indexOf("[");
  if (start === -1) return text;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/**
 * Apply common LLM-output repairs. Order matters — earlier passes
 * normalise quotes / smart-quotes before later passes try to match on
 * standard JSON characters.
 */
function repairJson(s: string): string {
  let out = s;

  // 1. Normalise smart / curly quotes to ASCII double quotes.
  out = out.replace(/[“”„‟]/g, '"');
  out = out.replace(/[‘’‚‛]/g, "'");

  // 2. Strip ``// ...`` and ``/* ... */`` comments (Qwen sometimes adds
  //    these despite being told not to).
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  // 3. Remove trailing commas before ``}`` or ``]``.
  out = out.replace(/,(\s*[}\]])/g, "$1");

  // 4. If single-quoted strings look like the dominant style, convert
  //    them to double quotes. Detect heuristically — only when we see
  //    ``'key':`` patterns that aren't inside a real string.
  if (/[{,]\s*'[^']+'\s*:/.test(out)) {
    // Walk the string and toggle ' → " outside of double-quoted strings.
    let result = "";
    let inDouble = false;
    let escape = false;
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (escape) {
        result += c;
        escape = false;
        continue;
      }
      if (c === "\\") {
        result += c;
        escape = true;
        continue;
      }
      if (c === '"') {
        inDouble = !inDouble;
        result += c;
        continue;
      }
      if (!inDouble && c === "'") {
        result += '"';
        continue;
      }
      result += c;
    }
    out = result;
  }

  // 5. Quote bare keys: ``{ foo: 1 }`` → ``{ "foo": 1 }``. Only the
  //    first token after ``{`` or ``,``, so we don't mangle string
  //    values.
  out = out.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');

  return out;
}

/**
 * Balance unclosed brackets at the end of the string. Handles the
 * common "completion ran out of tokens mid-JSON" case — Qwen-Flash
 * occasionally truncates near max_tokens.
 */
function balanceBrackets(s: string): string {
  let openCurly = 0;
  let openSquare = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") openCurly++;
    else if (c === "}") openCurly--;
    else if (c === "[") openSquare++;
    else if (c === "]") openSquare--;
  }
  // Close in reverse order — last-opened goes first.
  let suffix = "";
  // If we're stuck inside a string when the input ends, close it.
  if (inString) suffix += '"';
  // Heuristic: if last meaningful char is a comma, drop it (trailing).
  let trimmed = s.replace(/,\s*$/, "");
  // Close any unclosed brackets.
  while (openSquare > 0) {
    suffix += "]";
    openSquare--;
  }
  while (openCurly > 0) {
    suffix += "}";
    openCurly--;
  }
  return trimmed + suffix;
}
