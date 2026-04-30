import fs from 'node:fs';
import path from 'node:path';
import { CozoDb } from 'cozo-node';
import type { DecisionRuleFacts } from './types.js';

export interface DecisionRuleIndexOptions {
  dbPath: string;
}

export class DecisionRuleIndex {
  private readonly dbPath: string;
  private db: CozoDb | null = null;

  constructor(options: DecisionRuleIndexOptions) {
    this.dbPath = options.dbPath;
  }

  async open(): Promise<void> {
    if (this.db) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new CozoDb('sqlite', this.dbPath, {});
    await this.ensureSchema();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  async writeFacts(facts: DecisionRuleFacts): Promise<void> {
    await this.putRows('canonical', ['id', 'familyId', 'targetConcern', 'owningModule', 'confidence', 'status'], '{id => familyId, targetConcern, owningModule, confidence, status}', facts.canonical.map((item) => [item.id, item.familyId, item.targetConcern, item.owningModule, item.confidence, item.status]));
    await this.putRows('symmetry', ['id', 'familyId', 'fromUnit', 'toUnit', 'strength', 'score'], '{id => familyId, fromUnit, toUnit, strength, score}', facts.symmetry.map((item) => [item.id, item.familyId, item.fromUnit, item.toUnit, item.strength, item.score]));
    await this.putRows('closure', ['id', 'targetUnit', 'familyId'], '{id => targetUnit, familyId}', facts.closures.map((item) => [item.id, item.targetUnit, item.familyId]));
    await this.putRows('closure_member', ['closureId', 'unitId', 'level', 'confidence', 'reasons'], '{closureId, unitId => level, confidence, reasons}', facts.closureMembers.map((item) => [item.closureId, item.unitId, item.level, item.confidence, item.reasons]));
    await this.putRows('abstraction', ['id', 'familyId', 'title', 'owningModule', 'level', 'confidence', 'status'], '{id => familyId, title, owningModule, level, confidence, status}', facts.abstractions.map((item) => [item.id, item.familyId, item.title, item.owningModule, item.level, item.confidence, item.status]));
    await this.putRows('abstraction_unit', ['abstractionId', 'unitId'], '{abstractionId, unitId}', facts.abstractionUnits.map((item) => [item.abstractionId, item.unitId]));
    await this.putRows('plan', ['id', 'kind', 'totalScore'], '{id => kind, totalScore}', facts.plans.map((item) => [item.id, item.kind, item.totalScore]));
    await this.putRows('review', ['id', 'severity', 'finding'], '{id => severity, finding}', facts.reviews.map((item) => [item.id, item.severity, item.finding]));
    await this.putRows('plan_covers_closure', ['from', 'to'], '{from, to}', facts.planCoversClosure.map((item) => [item.from, item.to]));
    await this.putRows('review_flags_plan', ['from', 'to'], '{from, to}', facts.reviewFlagsPlan.map((item) => [item.from, item.to]));
  }

  async closureFor(closureId: string): Promise<Array<{ unitId: string; confidence: number; level: string }>> {
    const result = await this.run(
      '?[unitId, confidence, level] := *closure_member{closureId: $closureId, unitId, confidence, level}',
      { closureId },
    );
    return result.rows.map((row: unknown[]) => ({
      unitId: String(row[0]),
      confidence: Number(row[1]),
      level: String(row[2]),
    }));
  }

  async highConfidenceCanonical(minConfidence: number): Promise<Array<{ id: string; confidence: number }>> {
    const result = await this.run(
      '?[id, confidence] := *canonical{id, confidence}, confidence >= $minConfidence',
      { minConfidence },
    );
    return result.rows.map((row: unknown[]) => ({ id: String(row[0]), confidence: Number(row[1]) }));
  }

  async canonicalForConcern(targetConcern: string): Promise<Array<{ id: string; owningModule: string; confidence: number; status: string }>> {
    const result = await this.run(
      '?[id, owningModule, confidence, status] := *canonical{id, targetConcern: $targetConcern, owningModule, confidence, status}',
      { targetConcern },
    );
    return result.rows.map((row: unknown[]) => ({
      id: String(row[0]),
      owningModule: String(row[1]),
      confidence: Number(row[2]),
      status: String(row[3]),
    }));
  }

  async listCanonical(): Promise<Array<{ id: string; familyId: string; targetConcern: string; owningModule: string; confidence: number; status: string }>> {
    const result = await this.run(
      '?[id, familyId, targetConcern, owningModule, confidence, status] := *canonical{id, familyId, targetConcern, owningModule, confidence, status}',
    );
    return result.rows.map((row: unknown[]) => ({
      id: String(row[0]),
      familyId: String(row[1]),
      targetConcern: String(row[2]),
      owningModule: String(row[3]),
      confidence: Number(row[4]),
      status: String(row[5]),
    }));
  }

  async reviewFindingsForPlan(planId: string): Promise<Array<{ severity: string; finding: string }>> {
    const result = await this.run(
      '?[severity, finding] := *review_flags_plan{from: reviewId, to: $planId}, *review{id: reviewId, severity, finding}',
      { planId },
    );
    return result.rows.map((row: unknown[]) => ({ severity: String(row[0]), finding: String(row[1]) }));
  }

  async abstractionTargets(limit = 20): Promise<Array<{ abstractionId: string; unitId: string; title: string }>> {
    const result = await this.run(
      '?[abstractionId, unitId, title] := *abstraction{id: abstractionId, title}, *abstraction_unit{abstractionId, unitId} :limit $limit',
      { limit },
    );
    return result.rows.map((row: unknown[]) => ({
      abstractionId: String(row[0]),
      unitId: String(row[1]),
      title: String(row[2]),
    }));
  }

  private async ensureSchema(): Promise<void> {
    const statements = [
      ':create canonical {id: String => familyId: String, targetConcern: String, owningModule: String, confidence: Float, status: String}',
      ':create symmetry {id: String => familyId: String, fromUnit: String, toUnit: String, strength: String, score: Float}',
      ':create closure {id: String => targetUnit: String, familyId: String}',
      ':create closure_member {closureId: String, unitId: String => level: String, confidence: Float, reasons: String}',
      ':create abstraction {id: String => familyId: String, title: String, owningModule: String, level: String, confidence: Float, status: String}',
      ':create abstraction_unit {abstractionId: String, unitId: String}',
      ':create plan {id: String => kind: String, totalScore: Float}',
      ':create review {id: String => severity: String, finding: String}',
      ':create plan_covers_closure {from: String, to: String}',
      ':create review_flags_plan {from: String, to: String}',
    ];
    for (const statement of statements) {
      try {
        await this.run(statement);
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message?: unknown }).message)
            : String(error);
        if (!message.includes('already exists') && !message.includes('conflicts with an existing one')) {
          throw error;
        }
      }
    }
  }

  private async putRows(table: string, columns: string[], keySpec: string, rows: unknown[][]): Promise<void> {
    if (rows.length === 0) return;
    await this.run(`?[${columns.join(', ')}] <- $rows :put ${table} ${keySpec}`, { rows });
  }

  private async run(script: string, params: Record<string, unknown> = {}): Promise<{ rows: unknown[][] }> {
    if (!this.db) throw new Error('DecisionRuleIndex is not open');
    return this.db.run(script, params) as Promise<{ rows: unknown[][] }>;
  }
}
