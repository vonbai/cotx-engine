import {
  buildTruthCorrectionRegressionPlan,
  formatTruthCorrectionRegressionPlanMarkdown,
  summarizeTruthCorrections,
  updateTruthCorrectionStatus,
  validateTruthCorrectionRecords,
  type CotxTruthCorrectionRecord,
  type CotxTruthCorrectionStatus,
} from '../compiler/truth-correction-proposals.js';

export interface CommandTruthCorrectionsOptions {
  json?: boolean;
  limit?: number;
  plan?: boolean;
  minConfidence?: 'low' | 'medium' | 'high';
  validate?: boolean;
  setStatus?: string;
  status?: CotxTruthCorrectionStatus;
  reason?: string;
}

export async function commandTruthCorrections(
  projectRoot: string,
  options: CommandTruthCorrectionsOptions = {},
): Promise<void> {
  if (options.setStatus) {
    if (!options.status) throw new Error('--status is required with --set-status');
    const record = updateTruthCorrectionStatus(projectRoot, options.setStatus, options.status, {
      reason: options.reason,
    });
    console.log(options.json ? JSON.stringify(record, null, 2) : `Updated ${record.id} → ${record.status}`);
    return;
  }

  if (options.validate) {
    const validation = await validateTruthCorrectionRecords(projectRoot);
    console.log(JSON.stringify(validation, null, 2));
    return;
  }

  if (options.plan) {
    const plan = buildTruthCorrectionRegressionPlan(projectRoot, {
      minConfidence: options.minConfidence ?? 'medium',
    });
    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    console.log(formatTruthCorrectionRegressionPlanMarkdown(plan));
    return;
  }

  const summary = summarizeTruthCorrections(projectRoot);
  const limit = options.limit ?? 20;
  if (options.json) {
    console.log(JSON.stringify({
      ...summary,
      records: summary.records.slice(-limit),
    }, null, 2));
    return;
  }

  console.log(`# Truth Correction Proposals\n`);
  console.log(`Total: ${summary.total}`);
  console.log(`High confidence: ${summary.high_confidence}`);
  if (summary.latest_created_at) console.log(`Latest: ${summary.latest_created_at}`);
  console.log('');

  if (summary.total === 0) {
    console.log('No truth correction proposals recorded.');
    return;
  }

  console.log('By kind:');
  for (const [kind, count] of Object.entries(summary.by_kind).filter(([, count]) => count > 0)) {
    console.log(`- ${kind}: ${count}`);
  }
  console.log('');
  console.log('By status:');
  for (const [status, count] of Object.entries(summary.by_status).filter(([, count]) => count > 0)) {
    console.log(`- ${status}: ${count}`);
  }
  console.log('');
  console.log('Recent proposals:');
  for (const record of summary.records.slice(-limit)) {
    printRecord(record);
  }
}

function printRecord(record: CotxTruthCorrectionRecord): void {
  console.log(`- ${record.id} ${record.layer}/${record.kind}: ${record.title} (${record.confidence}, ${record.status})`);
  console.log(`  Proposed: ${record.proposed_fact}`);
  if (record.current_fact) console.log(`  Current: ${record.current_fact}`);
  if (record.evidence_file_paths.length > 0) console.log(`  Evidence: ${record.evidence_file_paths.join(', ')}`);
  if (record.suggested_test) console.log(`  Test: ${record.suggested_test}`);
}
