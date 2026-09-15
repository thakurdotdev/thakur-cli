import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Project-type detection.
 *
 * Scans the project root for well-known config files and lockfiles to infer
 * the language ecosystem, framework, package manager, test runner, linter,
 * formatter, build tool, monorepo layout, and CI/CD system. Every probe is
 * fail-soft — an unreadable file or missing entry degrades to `undefined`
 * instead of throwing. Results feed the system prompt so the agent follows
 * project conventions from the first turn.
 */

export interface ProjectContext {
  /** Primary languages detected (e.g. ["typescript", "javascript"]). */
  readonly languages: string[];
  /** Framework when recognizable (e.g. "next.js", "react", "express"). */
  readonly framework: string | undefined;
  /** Package manager inferred from lockfile. */
  readonly packageManager: string | undefined;
  /** Test runner inferred from config or scripts. */
  readonly testRunner: string | undefined;
  /** Linter inferred from config files. */
  readonly linter: string | undefined;
  /** Formatter inferred from config files. */
  readonly formatter: string | undefined;
  /** Build tool inferred from config files. */
  readonly buildTool: string | undefined;
  /** True when the project uses workspace-style monorepo layout. */
  readonly monorepo: boolean;
  /** CI/CD system detected from config directories. */
  readonly cicd: string | undefined;
  /** npm scripts from package.json (test, lint, format, build, dev). */
  readonly scripts: Readonly<Record<string, string>>;
}

function fileExists(cwd: string, name: string): boolean {
  try {
    return existsSync(join(cwd, name));
  } catch {
    return false;
  }
}

function readJson(cwd: string, name: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(join(cwd, name), "utf8");
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function dirExists(cwd: string, name: string): boolean {
  try {
    const entries = readdirSync(join(cwd, name), { withFileTypes: true });
    return entries.length > 0;
  } catch {
    return false;
  }
}

function allDependencies(pkg: Record<string, unknown>): Record<string, unknown> {
  const deps = pkg["dependencies"];
  const devDeps = pkg["devDependencies"];
  return {
    ...(typeof deps === "object" && deps !== null ? (deps as Record<string, unknown>) : {}),
    ...(typeof devDeps === "object" && devDeps !== null
      ? (devDeps as Record<string, unknown>)
      : {}),
  };
}

function detectLanguages(cwd: string, pkg: Record<string, unknown> | null): string[] {
  const langs = new Set<string>();

  if (fileExists(cwd, "tsconfig.json") || fileExists(cwd, "tsconfig.base.json")) {
    langs.add("typescript");
  }
  if (pkg !== null) {
    langs.add("javascript");
    // Check for TypeScript in dependencies
    const deps = allDependencies(pkg);
    if ("typescript" in deps) {
      langs.add("typescript");
    }
  }
  if (
    fileExists(cwd, "pyproject.toml") ||
    fileExists(cwd, "setup.py") ||
    fileExists(cwd, "setup.cfg") ||
    fileExists(cwd, "requirements.txt")
  ) {
    langs.add("python");
  }
  if (fileExists(cwd, "go.mod")) {
    langs.add("go");
  }
  if (fileExists(cwd, "Cargo.toml")) {
    langs.add("rust");
  }
  if (fileExists(cwd, "Gemfile")) {
    langs.add("ruby");
  }
  if (
    fileExists(cwd, "pom.xml") ||
    fileExists(cwd, "build.gradle") ||
    fileExists(cwd, "build.gradle.kts")
  ) {
    langs.add("java");
  }
  if (fileExists(cwd, "mix.exs")) {
    langs.add("elixir");
  }
  if (fileExists(cwd, "composer.json")) {
    langs.add("php");
  }

  return [...langs];
}

function detectPackageManager(cwd: string): string | undefined {
  if (fileExists(cwd, "bun.lock") || fileExists(cwd, "bun.lockb")) {
    return "bun";
  }
  if (fileExists(cwd, "pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (fileExists(cwd, "yarn.lock")) {
    return "yarn";
  }
  if (fileExists(cwd, "package-lock.json")) {
    return "npm";
  }
  // Python
  if (fileExists(cwd, "poetry.lock")) {
    return "poetry";
  }
  if (fileExists(cwd, "uv.lock")) {
    return "uv";
  }
  if (fileExists(cwd, "Pipfile.lock")) {
    return "pipenv";
  }
  // Rust
  if (fileExists(cwd, "Cargo.lock")) {
    return "cargo";
  }
  // Go
  if (fileExists(cwd, "go.sum")) {
    return "go";
  }
  return undefined;
}

function detectFramework(cwd: string, pkg: Record<string, unknown> | null): string | undefined {
  if (pkg === null) {
    // Python frameworks
    if (fileExists(cwd, "manage.py")) {
      return "django";
    }
    return undefined;
  }

  const deps = allDependencies(pkg);

  // Order matters: more specific before more generic.
  if ("next" in deps) {
    return "next.js";
  }
  if ("nuxt" in deps) {
    return "nuxt";
  }
  if ("@remix-run/node" in deps || "@remix-run/react" in deps) {
    return "remix";
  }
  if ("svelte" in deps || "@sveltejs/kit" in deps) {
    return fileExists(cwd, "svelte.config.js") || fileExists(cwd, "svelte.config.ts")
      ? "sveltekit"
      : "svelte";
  }
  if ("astro" in deps) {
    return "astro";
  }
  if ("vue" in deps) {
    return "vue";
  }
  if ("react" in deps || "react-dom" in deps) {
    return "react";
  }
  if ("angular" in deps || "@angular/core" in deps) {
    return "angular";
  }
  if ("express" in deps) {
    return "express";
  }
  if ("fastify" in deps) {
    return "fastify";
  }
  if ("hono" in deps) {
    return "hono";
  }
  if ("elysia" in deps) {
    return "elysia";
  }
  if ("electron" in deps) {
    return "electron";
  }
  if ("react-native" in deps) {
    return "react-native";
  }

  return undefined;
}

function detectTestRunner(cwd: string, pkg: Record<string, unknown> | null): string | undefined {
  // Config files
  if (
    fileExists(cwd, "vitest.config.ts") ||
    fileExists(cwd, "vitest.config.js") ||
    fileExists(cwd, "vitest.config.mts")
  ) {
    return "vitest";
  }
  if (
    fileExists(cwd, "jest.config.ts") ||
    fileExists(cwd, "jest.config.js") ||
    fileExists(cwd, "jest.config.mjs")
  ) {
    return "jest";
  }
  if (fileExists(cwd, "playwright.config.ts") || fileExists(cwd, "playwright.config.js")) {
    return "playwright";
  }
  if (fileExists(cwd, "cypress.config.ts") || fileExists(cwd, "cypress.config.js")) {
    return "cypress";
  }
  if (fileExists(cwd, "pytest.ini") || fileExists(cwd, "conftest.py")) {
    return "pytest";
  }

  // Dependency check
  if (pkg !== null) {
    const deps = allDependencies(pkg);
    if ("vitest" in deps) {
      return "vitest";
    }
    if ("jest" in deps) {
      return "jest";
    }
    if ("mocha" in deps) {
      return "mocha";
    }
    if ("ava" in deps) {
      return "ava";
    }
  }

  return undefined;
}

function detectLinter(cwd: string, pkg: Record<string, unknown> | null): string | undefined {
  // Config files
  if (fileExists(cwd, ".oxlintrc.json") || fileExists(cwd, "oxlintrc.json")) {
    return "oxlint";
  }
  if (
    fileExists(cwd, ".eslintrc.json") ||
    fileExists(cwd, ".eslintrc.js") ||
    fileExists(cwd, ".eslintrc.cjs") ||
    fileExists(cwd, "eslint.config.js") ||
    fileExists(cwd, "eslint.config.mjs") ||
    fileExists(cwd, "eslint.config.ts")
  ) {
    return "eslint";
  }
  if (fileExists(cwd, "biome.json") || fileExists(cwd, "biome.jsonc")) {
    return "biome";
  }
  if (fileExists(cwd, ".flake8") || fileExists(cwd, ".pylintrc")) {
    return fileExists(cwd, ".pylintrc") ? "pylint" : "flake8";
  }
  if (fileExists(cwd, "ruff.toml") || fileExists(cwd, ".ruff.toml")) {
    return "ruff";
  }

  // Dependency check
  if (pkg !== null) {
    const deps = allDependencies(pkg);
    if ("oxlint" in deps) {
      return "oxlint";
    }
    if ("eslint" in deps) {
      return "eslint";
    }
    if ("@biomejs/biome" in deps) {
      return "biome";
    }
  }

  return undefined;
}

function detectFormatter(cwd: string, pkg: Record<string, unknown> | null): string | undefined {
  if (fileExists(cwd, ".oxfmtrc.json")) {
    return "oxfmt";
  }
  if (
    fileExists(cwd, ".prettierrc") ||
    fileExists(cwd, ".prettierrc.json") ||
    fileExists(cwd, ".prettierrc.js") ||
    fileExists(cwd, "prettier.config.js") ||
    fileExists(cwd, "prettier.config.mjs")
  ) {
    return "prettier";
  }
  if (fileExists(cwd, "biome.json") || fileExists(cwd, "biome.jsonc")) {
    return "biome";
  }
  if (fileExists(cwd, "rustfmt.toml") || fileExists(cwd, ".rustfmt.toml")) {
    return "rustfmt";
  }

  if (pkg !== null) {
    const deps = allDependencies(pkg);
    if ("oxfmt" in deps) {
      return "oxfmt";
    }
    if ("prettier" in deps) {
      return "prettier";
    }
  }

  return undefined;
}

function detectBuildTool(cwd: string, pkg: Record<string, unknown> | null): string | undefined {
  if (fileExists(cwd, "vite.config.ts") || fileExists(cwd, "vite.config.js")) {
    return "vite";
  }
  if (fileExists(cwd, "webpack.config.js") || fileExists(cwd, "webpack.config.ts")) {
    return "webpack";
  }
  if (fileExists(cwd, "rollup.config.js") || fileExists(cwd, "rollup.config.ts")) {
    return "rollup";
  }
  if (fileExists(cwd, "turbo.json")) {
    return "turborepo";
  }
  if (fileExists(cwd, "esbuild.config.js") || fileExists(cwd, "esbuild.config.ts")) {
    return "esbuild";
  }
  if (fileExists(cwd, "Makefile")) {
    return "make";
  }
  if (fileExists(cwd, "CMakeLists.txt")) {
    return "cmake";
  }

  if (pkg !== null) {
    const deps = allDependencies(pkg);
    if ("vite" in deps) {
      return "vite";
    }
    if ("webpack" in deps) {
      return "webpack";
    }
    if ("esbuild" in deps) {
      return "esbuild";
    }
    if ("turbo" in deps) {
      return "turborepo";
    }
  }

  return undefined;
}

function detectMonorepo(cwd: string, pkg: Record<string, unknown> | null): boolean {
  if (pkg !== null) {
    if (Array.isArray(pkg["workspaces"])) {
      return true;
    }
    // Yarn/npm workspaces can also be an object with `packages`
    const workspaces = pkg["workspaces"];
    if (workspaces !== null && typeof workspaces === "object" && !Array.isArray(workspaces)) {
      return true;
    }
  }
  if (fileExists(cwd, "pnpm-workspace.yaml")) {
    return true;
  }
  if (fileExists(cwd, "lerna.json")) {
    return true;
  }
  if (fileExists(cwd, "nx.json")) {
    return true;
  }
  return false;
}

function detectCicd(cwd: string): string | undefined {
  if (dirExists(cwd, ".github/workflows")) {
    return "github-actions";
  }
  if (fileExists(cwd, ".gitlab-ci.yml")) {
    return "gitlab-ci";
  }
  if (fileExists(cwd, "Jenkinsfile")) {
    return "jenkins";
  }
  if (fileExists(cwd, ".circleci/config.yml")) {
    return "circleci";
  }
  if (fileExists(cwd, "azure-pipelines.yml")) {
    return "azure-devops";
  }
  if (fileExists(cwd, "bitbucket-pipelines.yml")) {
    return "bitbucket-pipelines";
  }
  return undefined;
}

function extractScripts(pkg: Record<string, unknown> | null): Record<string, string> {
  if (pkg === null) {
    return {};
  }
  const scripts = pkg["scripts"];
  if (scripts === null || scripts === undefined || typeof scripts !== "object") {
    return {};
  }
  const result: Record<string, string> = {};
  const interesting = [
    "test",
    "test:watch",
    "lint",
    "format",
    "format:check",
    "build",
    "dev",
    "start",
    "typecheck",
    "check",
    "verify",
  ];
  for (const key of interesting) {
    const value = (scripts as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Detect the project's toolchain from the filesystem. Every probe is
 * fail-soft: missing files produce `undefined` fields, never exceptions.
 */
export function detectProject(cwd: string): ProjectContext {
  const pkg = readJson(cwd, "package.json");

  return {
    languages: detectLanguages(cwd, pkg),
    framework: detectFramework(cwd, pkg),
    packageManager: detectPackageManager(cwd),
    testRunner: detectTestRunner(cwd, pkg),
    linter: detectLinter(cwd, pkg),
    formatter: detectFormatter(cwd, pkg),
    buildTool: detectBuildTool(cwd, pkg),
    monorepo: detectMonorepo(cwd, pkg),
    cicd: detectCicd(cwd),
    scripts: extractScripts(pkg),
  };
}

/**
 * Format project context into a concise block for the system prompt.
 * Returns an empty string when nothing was detected (non-code directory).
 */
export function formatProjectContext(ctx: ProjectContext): string {
  const parts: string[] = [];

  if (ctx.languages.length > 0) {
    parts.push(`Languages: ${ctx.languages.join(", ")}`);
  }
  if (ctx.framework !== undefined) {
    parts.push(`Framework: ${ctx.framework}`);
  }
  if (ctx.packageManager !== undefined) {
    parts.push(`Package manager: ${ctx.packageManager}`);
  }
  if (ctx.monorepo) {
    parts.push("Layout: monorepo (workspaces)");
  }
  if (ctx.testRunner !== undefined) {
    parts.push(`Test runner: ${ctx.testRunner}`);
  }
  if (ctx.linter !== undefined) {
    parts.push(`Linter: ${ctx.linter}`);
  }
  if (ctx.formatter !== undefined) {
    parts.push(`Formatter: ${ctx.formatter}`);
  }
  if (ctx.buildTool !== undefined) {
    parts.push(`Build tool: ${ctx.buildTool}`);
  }
  if (ctx.cicd !== undefined) {
    parts.push(`CI/CD: ${ctx.cicd}`);
  }

  // Actionable script commands the agent should use
  const scriptHints: string[] = [];
  const pm = ctx.packageManager ?? "npm";
  const run = pm === "npm" ? "npm run" : pm;
  if (ctx.scripts["test"] !== undefined) {
    scriptHints.push(`Run tests: \`${run} test\``);
  }
  if (ctx.scripts["typecheck"] !== undefined) {
    scriptHints.push(`Type-check: \`${run} typecheck\``);
  }
  if (ctx.scripts["lint"] !== undefined) {
    scriptHints.push(`Lint: \`${run} lint\``);
  }
  if (ctx.scripts["format:check"] !== undefined) {
    scriptHints.push(`Check formatting: \`${run} format:check\``);
  } else if (ctx.scripts["format"] !== undefined) {
    scriptHints.push(`Format: \`${run} format\``);
  }
  if (ctx.scripts["build"] !== undefined) {
    scriptHints.push(`Build: \`${run} build\``);
  }
  if (ctx.scripts["verify"] !== undefined) {
    scriptHints.push(`Full verification: \`${run} verify\``);
  }

  if (parts.length === 0) {
    return "";
  }

  const sections = ["## Project toolchain", "", ...parts];
  if (scriptHints.length > 0) {
    sections.push("", "Available scripts:", ...scriptHints.map((hint) => `  ${hint}`));
  }

  return sections.join("\n");
}
