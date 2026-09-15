import { z } from "zod";

/**
 * Environment boundary: nothing enters the system unparsed.
 * Validated once at boot; everything else reads from this typed result.
 */
export const HarnessEnvSchema = z.object({
  // Provider credentials (all optional — resolveModel fails with an
  // actionable hint for whichever provider the user actually picked).
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  // Google accepts either spelling; the alias is resolved in resolveModel.
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  GOOGLE_API_KEY: z.string().min(1).optional(),

  // Optional endpoint overrides for self-hosted / proxied deployments.
  OPENAI_BASE_URL: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().min(1).optional(),
  GOOGLE_BASE_URL: z.string().min(1).optional(),

  HARNESS_MODEL: z.string().min(1).optional(),
  HARNESS_SMOKE_MODEL: z.string().min(1).optional(),
  HARNESS_SMOKE_PROMPT: z.string().min(1).optional(),
  NO_COLOR: z.string().optional(),
});

export type HarnessEnv = z.infer<typeof HarnessEnvSchema>;

/** Google's key under either spelling — AI Studio docs use both. */
export function googleApiKey(env: HarnessEnv): string | undefined {
  return env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GOOGLE_API_KEY;
}

export function parseHarnessEnv(env: Record<string, string | undefined>): HarnessEnv {
  const result = HarnessEnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
