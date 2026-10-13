import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

export function tempProject(files: Record<string, string>): string {
  const root = join(tmpdir(), `eas-update-diagnose-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

export async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    color: false,
  });
  return { code, stdout, stderr };
}

export function codes(checks: Array<{ code: string; status: string }>, status?: string): string[] {
  return checks.filter((check) => !status || check.status === status).map((check) => check.code);
}
