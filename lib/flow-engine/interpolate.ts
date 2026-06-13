/**
 * Replace {{key}} placeholders in `text` with values from `variables`.
 * Dotted keys are supported so workspace bot fields interpolate as
 * {{bot.slug}}; plain {{name}} keys keep working as before. Unknown keys are
 * left literal.
 */
export function interpolateVariables(
  text: string,
  variables: Record<string, unknown>
): string {
  return text.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    return String(variables[key] ?? `{{${key}}}`);
  });
}
