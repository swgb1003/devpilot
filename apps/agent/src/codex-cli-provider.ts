import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from './command.js';
import { AgentError } from './errors.js';

export interface CodexContextFile {
  readonly path: string;
  readonly content: string;
}

export interface CodexFixContext {
  readonly instruction: string;
  readonly annotation: Readonly<Record<string, unknown>>;
  readonly projectName: string;
  readonly files: readonly CodexContextFile[];
}

export interface CodexProposal {
  readonly summary: string;
  readonly risks: readonly string[];
  readonly files: readonly CodexContextFile[];
}

const proposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'risks', 'files'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    risks: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 500 } },
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 300 },
          content: { type: 'string', maxLength: 200000 },
        },
      },
    },
  },
} as const;

// A first proposal can require starting the CLI and reading a Flutter screen.
// Keep this below the mobile request timeout (which includes a small transport
// allowance) while giving the model enough time to finish a complete response.
export const codexProposalTimeoutMs = 300_000;

export class CodexCliProvider {
  async propose(context: CodexFixContext): Promise<CodexProposal> {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'devpilot-codex-'));
    const outputPath = join(workingDirectory, 'proposal.json');
    const schemaPath = join(workingDirectory, 'proposal-schema.json');
    try {
      writeFileSync(schemaPath, JSON.stringify(proposalSchema), 'utf8');
      writeFileSync(join(workingDirectory, 'context.json'), JSON.stringify(context), 'utf8');
      const prompt = [
        "You are DevPilot's patch proposal assistant.",
        'Read context.json in the current directory. Return only JSON following the supplied schema.',
        'Propose a minimal fix for the Japanese user instruction and the normalized screen annotation.',
        'Only return complete replacement content for existing paths listed in context.json.',
        'Preserve every unrelated byte of each file, especially Japanese text and comments; output valid UTF-8 only.',
        'Never add files, never change pubspec/native/build/git files, and do not use tools to write files.',
        'Explain uncertainty briefly in risks. Do not include Markdown fences.',
      ].join(' ');
      const result = await runCommand(
        resolveCodexExecutable(),
        [
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '-C',
          workingDirectory,
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outputPath,
          prompt,
        ],
        codexProposalTimeoutMs,
        { cwd: workingDirectory, environment: codexEnvironment() },
      );
      if (result.timedOut || result.exitCode !== 0 || !existsSync(outputPath)) {
        throw unavailable(
          result.timedOut ? 'Codex の応答がタイムアウトしました。' : compactDiagnostic(result),
        );
      }
      return parseProposal(readFileSync(outputPath, 'utf8'));
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw unavailable(
        error instanceof Error ? error.message : 'Codex CLI を起動できませんでした。',
      );
    } finally {
      // The directory contains only the bounded, temporary context created above.
      rmSync(workingDirectory, { recursive: true, force: true, maxRetries: 2 });
    }
  }
}

function codexEnvironment(): NodeJS.ProcessEnv {
  const home = homedir();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    // Codex CLI installed by the VS Code extension relies on HOME to locate
    // the existing ChatGPT login. Node/tsx sessions on Windows may omit it.
    HOME: home,
    USERPROFILE: home,
    // Match the authenticated environment that succeeds when the user runs
    // Codex directly. A partial temporary copy of this directory can make a
    // valid ChatGPT login fail in the Agent process.
    CODEX_HOME: join(home, '.codex'),
  };
  // DevPilot may itself be launched from a Codex-managed terminal. This flag
  // is correct for the parent sandbox but must not disable the user's opted-in
  // Codex CLI network connection.
  delete environment.CODEX_SANDBOX_NETWORK_DISABLED;
  delete environment.CODEX_CI;
  return environment;
}

function resolveCodexExecutable(): string {
  const configured = process.env.DEVPILOT_CODEX_COMMAND;
  if (configured) return configured;
  if (process.platform === 'win32') {
    const extensions = join(homedir(), '.vscode', 'extensions');
    try {
      const candidate = readdirSync(extensions)
        .filter((entry) => entry.startsWith('openai.chatgpt-'))
        .sort()
        .reverse()
        .map((entry) => join(extensions, entry, 'bin', 'windows-x86_64', 'codex.exe'))
        .find(existsSync);
      if (candidate) return candidate;
    } catch {
      // A globally installed `codex` command is the final fallback.
    }
  }
  return 'codex';
}

function parseProposal(raw: string): CodexProposal {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.summary !== 'string' ||
      !Array.isArray(candidate.risks) ||
      !Array.isArray(candidate.files) ||
      candidate.risks.some((risk) => typeof risk !== 'string') ||
      candidate.files.some(
        (file) =>
          typeof file !== 'object' ||
          file === null ||
          Array.isArray(file) ||
          typeof (file as Record<string, unknown>).path !== 'string' ||
          typeof (file as Record<string, unknown>).content !== 'string',
      )
    )
      throw new Error();
    return {
      summary: candidate.summary,
      risks: candidate.risks as string[],
      files: candidate.files as CodexContextFile[],
    };
  } catch {
    throw unavailable('Codex の修正案の形式を検証できませんでした。もう一度生成してください。');
  }
}

function compactDiagnostic(result: { readonly stderr: string; readonly stdout: string }): string {
  const diagnostic = (result.stderr || result.stdout).replaceAll(/\s+/g, ' ').trim().slice(0, 500);
  return diagnostic
    ? `Codex CLI を利用できませんでした: ${diagnostic}`
    : 'Codex CLI を利用できませんでした。VS Code の Codex ログインを確認してください。';
}

function unavailable(message: string): AgentError {
  return new AgentError({
    code: 'AI_PROVIDER_UNAVAILABLE',
    message,
    status: 503,
    retryable: true,
    action: 'RETRY',
  });
}
