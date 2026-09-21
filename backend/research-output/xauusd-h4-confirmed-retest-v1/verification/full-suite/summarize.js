// Summarizes vitest JSON reports: totals and every failed test with its first error line.
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  if (!fs.existsSync(f)) { console.log(`${f}: (missing)`); continue; }
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(`${f}: files=${r.numTotalTestSuites} tests=${r.numTotalTests} passed=${r.numPassedTests} failed=${r.numFailedTests} pending=${r.numPendingTests} success=${r.success}`);
  for (const s of r.testResults) for (const t of s.assertionResults) if (t.status === 'failed') {
    const msg = (t.failureMessages[0] || '').split('\n')[0].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 220);
    console.log(`  FAIL ${s.name.split(/[\/]test[\/]/).pop()} > ${t.fullName}\n       ${msg}`);
  }
}
