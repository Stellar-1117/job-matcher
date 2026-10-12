import { TEMPLATE_VARIABLES, VOLATILE_VARIABLES, type TemplateVariable } from '@shared/tasks';
import type { PromptPart } from './types';

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export type TemplateVars = Partial<Record<TemplateVariable, string>>;

export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VAR_RE)].map((m) => m[1]))];
}

export function unknownVariables(template: string): string[] {
  return templateVariables(template).filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v));
}

function substitute(text: string, vars: TemplateVars): string {
  return text.replace(VAR_RE, (whole, name: string) => {
    const v = vars[name as TemplateVariable];
    return v === undefined ? whole : v;
  });
}

/**
 * Render a prompt template into message parts. Everything before the first job-specific variable
 * ({{job_text}} / {{job_fields}}) is the stable prefix (instructions, resume, profile) and is marked
 * as a cache breakpoint so providers can reuse it across jobs for the same profile.
 */
export function renderTemplate(template: string, vars: TemplateVars): PromptPart[] {
  let splitAt = -1;
  for (const m of template.matchAll(VAR_RE)) {
    if ((VOLATILE_VARIABLES as string[]).includes(m[1])) {
      splitAt = m.index!;
      break;
    }
  }
  if (splitAt <= 0) return [{ text: substitute(template, vars) }];
  const stable = substitute(template.slice(0, splitAt), vars);
  const rest = substitute(template.slice(splitAt), vars);
  return [{ text: stable, cache: true }, { text: rest }];
}

/** Pull a JSON object out of a model response (tolerates code fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error('Response contained no JSON object');
}
