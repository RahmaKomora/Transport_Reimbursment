import { run } from './db.js';
import { groupByRegion } from './savings.js';

const HR_RECIPIENTS = (process.env.SONGA_HR_EMAILS || '').split(',').map((value) => value.trim()).filter(Boolean);

const money = (value) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(value || 0);

/**
 * Builds the HR summary for a closed cycle, grouped by region.
 * Pure: returns the report, sends nothing. Tested directly.
 */
export function buildBatchReport(cycle, claims) {
  const regions = groupByRegion(claims).map((region) => ({
    ...region,
    staff: new Set(region.claims.map((claim) => claim.submittedBy)).size,
  }));
  const total = regions.reduce((sum, region) => sum + region.total, 0);

  return {
    cycleKey: cycle.key,
    cycleLabel: cycle.label,
    range: cycle.range,
    generatedAt: new Date().toISOString(),
    claimCount: claims.length,
    total,
    regions,
    subject: `Songa: ${cycle.label} (${cycle.range}) — ${claims.length} claims, ${money(total)} for payment`,
    text: renderText(cycle, regions, claims.length, total),
  };
}

function renderText(cycle, regions, count, total) {
  const lines = [
    `Songa reimbursement batch — ${cycle.label}, ${cycle.range}`,
    `Sealed ${new Date().toISOString()}`,
    '',
    `${count} approved claim${count === 1 ? '' : 's'} totalling ${money(total)} are ready for payment.`,
    '',
  ];

  if (!regions.length) {
    lines.push('No approved claims in this cycle.');
    return lines.join('\n');
  }

  for (const region of regions) {
    lines.push(`${region.region} — ${region.claims.length} claim${region.claims.length === 1 ? '' : 's'}, ${money(region.total)} (${region.staff} staff)`);
    for (const claim of region.claims) {
      lines.push(`    ${claim.id}  ${claim.staffName || claim.submittedBy}  ${claim.zone || '-'}  ${money(claim.amount)}  ${Number(claim.km || 0).toFixed(1)} km`);
    }
    lines.push('');
  }

  lines.push('Open the Ready for Payment tab in Songa to process these.');
  return lines.join('\n');
}

/**
 * Delivers the report. There is no mail transport configured in this build, so the report
 * is kept in batch_reports and logged. Wiring real email means replacing the body of this
 * function — everything that decides *what* HR is told lives in buildBatchReport.
 *
 * In the database rather than a file because the file lived on the pod's disk, and a
 * batch record that vanishes at the next deploy is no record. They are real artefacts
 * either way, so a missed email never means a lost batch.
 */
export async function notifyHr(report) {
  let writtenTo = '';
  try {
    await run('INSERT INTO batch_reports (cycle_key, subject, body, recipients, created_at) VALUES (?, ?, ?, ?, ?)', [report.cycleKey, report.subject, report.text, HR_RECIPIENTS.join(','), report.generatedAt]);
    writtenTo = `batch_reports/${report.cycleKey}`;
  } catch (error) {
    console.error('[notify] could not store the batch report:', error.message);
  }

  console.log(`\n[notify] ${report.subject}`);
  console.log(`[notify] recipients: ${HR_RECIPIENTS.length ? HR_RECIPIENTS.join(', ') : 'none configured (set SONGA_HR_EMAILS)'}`);
  if (writtenTo) console.log(`[notify] report written to ${writtenTo}`);
  console.log(report.text);

  return { delivered: false, reason: 'No mail transport configured', writtenTo, recipients: HR_RECIPIENTS, report };
}
