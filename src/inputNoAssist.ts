/**
 * Spread onto text/search `<input>`s to disable browser autocompletion, spellcheck,
 * and mobile autocorrect/capitalization for path-like fields.
 */
export const INPUT_NO_ASSIST = {
  autoComplete: 'off' as const,
  spellCheck: false,
  autoCapitalize: 'none' as const,
} as const;
