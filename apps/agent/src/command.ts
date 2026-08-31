import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface CommandResult {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface BinaryCommandResult {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: Buffer;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface CommandOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

const maxCapturedOutput = 32_768;
const maxCapturedBinaryOutput = 8 * 1024 * 1024;

function appendOutput(current: string, chunk: Buffer): string {
  if (current.length >= maxCapturedOutput) {
    return current;
  }

  return (current + chunk.toString('utf8')).slice(0, maxCapturedOutput);
}

function needsWindowsCommandInterpreter(executable: string): boolean {
  return process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(executable);
}

function quoteForWindowsCommand(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function runCommand(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const startedAt = performance.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const settle = (exitCode: number | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        executable,
        arguments: arguments_,
        durationMs: Math.round(performance.now() - startedAt),
        exitCode,
        stderr,
        stdout,
        timedOut,
      });
    };

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = needsWindowsCommandInterpreter(executable)
        ? spawn(
            process.env.ComSpec ?? 'cmd.exe',
            [
              '/d',
              '/s',
              '/c',
              `"${[
                quoteForWindowsCommand(executable),
                ...arguments_.map(quoteForWindowsCommand),
              ].join(' ')}"`,
            ],
            {
              ...(options.environment ? { env: options.environment } : {}),
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsVerbatimArguments: true,
              windowsHide: true,
            },
          )
        : spawn(executable, arguments_, {
            ...(options.environment ? { env: options.environment } : {}),
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
    } catch (error) {
      stderr = appendOutput(
        stderr,
        Buffer.from(error instanceof Error ? error.message : String(error)),
      );
      resolve({
        executable,
        arguments: arguments_,
        durationMs: Math.round(performance.now() - startedAt),
        exitCode: null,
        stderr,
        stdout,
        timedOut,
      });
      return;
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });

    child.once('error', (error: Error) => {
      stderr = appendOutput(stderr, Buffer.from(error.message));
      settle(null);
    });

    child.once('close', (exitCode) => settle(exitCode));
  });
}

export async function runBinaryCommand(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  options: CommandOptions = {},
): Promise<BinaryCommandResult> {
  const startedAt = performance.now();

  return new Promise((resolve) => {
    let stderr = '';
    let stdout = Buffer.alloc(0);
    let timedOut = false;
    let truncated = false;
    let settled = false;

    const settle = (exitCode: number | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        executable,
        arguments: arguments_,
        durationMs: Math.round(performance.now() - startedAt),
        exitCode,
        stderr,
        stdout,
        timedOut,
        truncated,
      });
    };

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = needsWindowsCommandInterpreter(executable)
        ? spawn(
            process.env.ComSpec ?? 'cmd.exe',
            [
              '/d',
              '/s',
              '/c',
              `"${[
                quoteForWindowsCommand(executable),
                ...arguments_.map(quoteForWindowsCommand),
              ].join(' ')}"`,
            ],
            {
              ...(options.environment ? { env: options.environment } : {}),
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsVerbatimArguments: true,
              windowsHide: true,
            },
          )
        : spawn(executable, arguments_, {
            ...(options.environment ? { env: options.environment } : {}),
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
    } catch (error) {
      stderr = appendOutput(
        stderr,
        Buffer.from(error instanceof Error ? error.message : String(error)),
      );
      resolve({
        executable,
        arguments: arguments_,
        durationMs: Math.round(performance.now() - startedAt),
        exitCode: null,
        stderr,
        stdout,
        timedOut,
        truncated,
      });
      return;
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length >= maxCapturedBinaryOutput) {
        truncated = true;
        return;
      }

      const remaining = maxCapturedBinaryOutput - stdout.length;
      if (chunk.length > remaining) {
        truncated = true;
      }
      stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });

    child.once('error', (error: Error) => {
      stderr = appendOutput(stderr, Buffer.from(error.message));
      settle(null);
    });

    child.once('close', (exitCode) => settle(exitCode));
  });
}
