// Savestate fidelity sweep: A runs live, B restores A's savestate at
// several points; both then run identical inputs. Any divergence means the
// savestate misses some emulator state (netplay must then reload on host too).
//   node web/tests/sync-sweep.mjs <disc.cue> [reloadHost=0|1]
import { createCore } from '../tools/headless.mjs';
const [disc, reload = '0'] = process.argv.slice(2);
const a = await createCore({ discPath: disc });
const b = await createCore({ discPath: disc });
let f = 0, bad = 0;
for (const at of [150, 230, 270, 330, 420, 520, 700, 900]) {
  while (f < at) { a.setInput(0, 0); a.runFrame(); f++; }
  const st = a.saveState();
  if (reload === '1') a.loadState(st);
  b.loadState(st);
  let diverged = -1;
  for (let i = 0; i < 260; i++) {
    a.runFrame(); b.runFrame(); f++;
    if (diverged < 0 && i % 10 === 9 && a.ramHash() !== b.ramHash()) diverged = i;
  }
  console.log(`sync à l'image ${at}: ${diverged < 0 ? 'identique' : 'DIVERGE après ' + diverged + ' images'}`);
  if (diverged >= 0) bad++;
}
process.exit(bad ? 1 : 0);
