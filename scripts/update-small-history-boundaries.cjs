// Local data migration. Uses the application's schemas and boundary rule; no inference or video writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, filename);
const { historyRecordSchema } = require('../src/shared/contracts.ts');
const { updateSmallHistoryBoundaries } = require('../src/domain/small-history.ts');
const { createCutGroups } = require('../src/domain/segments.ts');
const apply = process.argv.includes('--apply');
const roots = process.argv.slice(2).filter(x => x !== '--apply');
if (!roots.length) throw new Error('Pass explicit history directories, optionally --apply');
for (const root of roots) {
  const directory = path.join(root, 'records');
  for (const filename of fs.readdirSync(directory).filter(x => x.endsWith('.json'))) {
    const target = path.join(directory, filename);
    const before = fs.readFileSync(target);
    const raw = JSON.parse(before.toString('utf8'));
    if (raw.analysis?.rally_recognition?.method !== 'mobilenet_small') continue;
    const record = historyRecordSchema.parse(raw);
    const analysis = updateSmallHistoryBoundaries(record.analysis);
    const updated = historyRecordSchema.parse({ ...record, analysis });
    const groups = analysis.rallies.length ? createCutGroups(analysis, { mode: 'all', pre_roll_seconds: 0, post_roll_seconds: 0 }) : [];
    const changed = analysis !== record.analysis;
    let backup = null;
    if (apply && changed) {
      backup = `${target}.before-small-play2s-serve1.5s-tail0.5s.bak`;
      fs.writeFileSync(backup, before, { flag: 'wx' });
      if (!before.equals(fs.readFileSync(target))) throw new Error(`History changed concurrently: ${target}`);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(updated, null, 2) + '\n');
      fs.renameSync(temporary, target);
      const reopened = historyRecordSchema.parse(JSON.parse(fs.readFileSync(target, 'utf8')));
      if (JSON.stringify(reopened) !== JSON.stringify(updated)) throw new Error(`Verification failed: ${target}`);
    }
    console.log(JSON.stringify({ video: record.source.name, target, changed, applied: apply && changed, backup,
      rallies: analysis.rallies.length, removed_short_play: record.analysis.rallies.length - analysis.rallies.length,
      trimmed: analysis.rallies.filter(r => r.default_clip_start_time_seconds > r.start_time_seconds).length,
      removed_seconds: analysis.rallies.reduce((sum, r) => sum + r.default_clip_start_time_seconds - r.start_time_seconds, 0),
      default_export_seconds: groups.reduce((sum, group) => sum + group.end - group.start, 0) }));
  }
}
