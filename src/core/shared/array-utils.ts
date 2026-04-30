/**
 * Safely append every element of `source` onto `target` without the
 * `target.push(...source)` spread-apply pattern. JS caps call-arg count at
 * ~60K on most engines, so a spread-push with that many elements crashes
 * with `RangeError: Maximum call stack size exceeded`. The parse pipeline
 * and enrichment paths see arrays that size on large repos (observed on
 * 7GB quantos: tens of thousands of resolved calls per chunk). Use this
 * helper for every cross-chunk array merge — an index-by-index push never
 * spreads onto the call stack regardless of source size.
 */
export function extendArray<T>(target: T[], source: readonly T[] | undefined | null): void {
  if (!source) return;
  for (let i = 0; i < source.length; i++) target.push(source[i]);
}
