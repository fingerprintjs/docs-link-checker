/** Code unit order (like the default `sort()`), not locale-dependent */
export const compareStrings = (a: string, b: string): number => Number(a > b) - Number(a < b);
