/**
 * Backward-compatible re-export. The repo-context builder now lives in
 * `@harness/core` (packages/core/src/context/repo.ts) so the SDK can produce
 * the same repository-aware system prompt as the CLI.
 */
export { buildRepoContext, buildSystemPrompt } from "@harness/core";
