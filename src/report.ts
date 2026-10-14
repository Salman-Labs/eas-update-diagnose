import { relative } from 'node:path';
import type { CheckStatus, Diagnosis } from './types.js';

export function formatReport(diagnosis: Diagnosis, color: boolean): string {
  const lines: string[] = [
    `eas-update-diagnose ${diagnosis.version}`,
    '',
    `project     ${displayPath(diagnosis.projectRoot)}`,
    `app config  ${diagnosis.appConfigPath ? displayPath(diagnosis.appConfigPath) : '(missing)'}`,
    `eas.json    ${diagnosis.easJsonPath ? displayPath(diagnosis.easJsonPath) : '(missing)'}`,
    `runtime     ${formatRuntime(diagnosis)}`,
    `updates url ${diagnosis.updatesUrl ?? '(missing)'}`,
    `platforms   ${diagnosis.platforms.join(', ') || '(none)'}`,
    '',
    'checklist',
  ];
  for (const check of diagnosis.checks) {
    lines.push(`  ${paint(check.status, color)}  ${check.code}`);
    lines.push(`        ${check.message}`);
  }
  lines.push('');
  const { fail, warn, pass } = diagnosis.summary;
  const result = fail > 0 ? 'FAIL' : 'PASS';
  lines.push(`result  ${paint(fail > 0 ? 'fail' : 'pass', color, result)}  ${fail} failed, ${warn} warning${warn === 1 ? '' : 's'}, ${pass} passed`);
  if (diagnosis.manifests.length > 0) {
    lines.push('');
    lines.push('manifests');
    for (const probe of diagnosis.manifests) {
      const outcome = probe.manifestRuntimeVersion
        ? `update ${probe.updateId ?? '(no id)'} runtime ${probe.manifestRuntimeVersion}`
        : (probe.directive ?? probe.error ?? 'no update');
      lines.push(`  ${probe.platform}  ${probe.channel}  ${probe.runtimeVersion}  HTTP ${probe.httpStatus ?? 'n/a'}  ${outcome}`);
    }
  }
  if (diagnosis.notes.length > 0) {
    lines.push('');
    lines.push('notes');
    for (const note of diagnosis.notes) lines.push(`  ${note}`);
  }
  return lines.join('\n');
}

function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  if (!rel || rel.startsWith('..')) return path;
  return rel;
}

function formatRuntime(diagnosis: Diagnosis): string {
  const entries = Object.entries(diagnosis.resolvedRuntime).filter((entry) => entry[1]);
  if (entries.length === 0) {
    if (diagnosis.runtimeVersion && typeof diagnosis.runtimeVersion === 'object') {
      return `policy ${diagnosis.runtimeVersion.policy} (unresolved)`;
    }
    return '(missing)';
  }
  const values = entries.map(([platform, value]) => `${platform} ${value}`).join(', ');
  if (diagnosis.runtimeVersion && typeof diagnosis.runtimeVersion === 'object') {
    return `${values} (policy ${diagnosis.runtimeVersion.policy})`;
  }
  return values;
}

function paint(status: CheckStatus, color: boolean, text = status.toUpperCase()): string {
  if (!color) return text;
  const codes: Record<CheckStatus, string> = { pass: '32', warn: '33', fail: '31' };
  return `\u001b[${codes[status]}m${text}\u001b[0m`;
}
