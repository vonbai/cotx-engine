#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatQualityProbeSummary, runQualityProbes } from './typed-graph-probes/index.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const today = new Date().toISOString().slice(0, 10);

const sourceRoot = process.env.SOURCE_ROOT ?? '/data/dev/cotx-engine';
const reposRoot = process.env.REPOS_ROOT ?? '/data/dev/goalx_test/repos';
const prsRoot = process.env.PRS_ROOT ?? '/data/dev/goalx_test/prs';
const referenceRoot = process.env.REFERENCE_ROOT ?? path.join(sourceRoot, 'example');
const outDir = path.resolve(
  process.env.OUT_DIR ?? `/data/dev/goalx_test/results/${today}/deterministic-layer-matrix`,
);
const workRoot = path.resolve(process.env.WORK_ROOT ?? path.join(outDir, 'workdirs'));
const matrixPrefix = process.env.MATRIX_PREFIX ?? 'deterministic-layer-matrix';
const cotxCli = path.resolve(process.env.COTX_CLI ?? path.join(projectRoot, 'dist', 'index.js'));
const dryRun = process.env.DRY_RUN === '1';
const reuseExistingCopies = process.env.REUSE_COPIES === '1';
const skipGitNexus = process.env.SKIP_GITNEXUS === '1';
const runChangeWorkflow = process.env.RUN_CHANGE_WORKFLOW === '1';
const failOnGap = process.env.FAIL_ON_GAP === '1';

const cliArgs = parseCliArgs(process.argv.slice(2));
if (cliArgs.help) {
  console.log(usage());
  process.exit(0);
}
if (cliArgs.error) {
  console.error(cliArgs.error);
  console.error('');
  console.error(usage());
  process.exit(1);
}

const copyTimeoutMs = numberEnv('COPY_TIMEOUT_MS', 300_000);
const compileTimeoutMs = numberEnv('COMPILE_TIMEOUT_MS', 600_000);
const analyzeTimeoutMs = numberEnv('GITNEXUS_ANALYZE_TIMEOUT_MS', 600_000);
const queryTimeoutMs = numberEnv('QUERY_TIMEOUT_MS', 90_000);
const changeTimeoutMs = numberEnv('CHANGE_TIMEOUT_MS', 60_000);

const finalJsonl = path.join(outDir, `${matrixPrefix}.jsonl`);
const finalMd = path.join(outDir, `${matrixPrefix}.md`);
const finalCommandLogPath = path.join(outDir, `${matrixPrefix}-commands.jsonl`);
const outJsonl = `${finalJsonl}.tmp`;
const outMd = `${finalMd}.tmp`;
const commandLogPath = `${finalCommandLogPath}.tmp`;

const layers = [
  'code graph / CodeRelation',
  'typed nodes / CodeRelation',
  'modules',
  'concepts',
  'contracts',
  'flows',
  'routes',
  'tools',
  'processes',
  'decision facts / doctrine / canonical paths',
  'architecture workspace / C4-style hierarchy / views',
  'change impact / review-change / plan-change',
];

const symbolLikeLabels = [
  'Function',
  'Property',
  'Method',
  'Module',
  'Struct',
  'Class',
  'Impl',
  'Interface',
  'TypeAlias',
  'Enum',
  'Const',
  'Static',
  'Trait',
  'Macro',
];

const knownRepos = new Map([
  ['cotx-engine', { group: 'self', source: projectRoot }],
  ['OpenHands', { group: 'primary', source: path.join(reposRoot, 'OpenHands') }],
  ['pydantic-ai', { group: 'primary', source: path.join(reposRoot, 'pydantic-ai') }],
  ['goose', { group: 'primary', source: path.join(reposRoot, 'goose') }],
  ['gptme', { group: 'primary', source: path.join(reposRoot, 'gptme') }],
  ['github-mcp-server', { group: 'primary', source: path.join(reposRoot, 'github-mcp-server') }],
  ['fastmcp', { group: 'primary', source: path.join(reposRoot, 'fastmcp') }],
  ['rolldown', { group: 'primary', source: path.join(reposRoot, 'rolldown') }],
  ['ruff', { group: 'primary', source: path.join(reposRoot, 'ruff') }],
  ['dolt', { group: 'primary', source: path.join(reposRoot, 'dolt') }],
  ['tabby', { group: 'primary', source: path.join(reposRoot, 'tabby') }],
  ['deer-flow', { group: 'secondary', source: path.join(reposRoot, 'deer-flow') }],
  ['ollama', { group: 'secondary', source: path.join(reposRoot, 'ollama') }],
  ['screenpipe', { group: 'secondary', source: path.join(reposRoot, 'screenpipe') }],
  ['zellij', { group: 'secondary', source: path.join(reposRoot, 'zellij') }],
  ['open-swe', { group: 'secondary', source: path.join(reposRoot, 'open-swe') }],
  ['oh-my-mermaid', { group: 'reference', source: path.join(referenceRoot, 'oh-my-mermaid') }],
  ['code-review-graph', { group: 'reference', source: path.join(referenceRoot, 'code-review-graph') }],
  ['flask', { group: 'pr-fixture', source: path.join(prsRoot, 'flask') }],
  ['gum', { group: 'pr-fixture', source: path.join(prsRoot, 'gum') }],
  ['mini-redis', { group: 'pr-fixture', source: path.join(prsRoot, 'mini-redis') }],
]);

const defaultRepoIds = [
  'cotx-engine',
  'fastmcp',
  'github-mcp-server',
  'ruff',
  'deer-flow',
  'open-swe',
  'oh-my-mermaid',
  'code-review-graph',
];

const rows = [];
const commandLog = [];
const qualityProbeRecords = [];
const repos = resolveRepos();

function resolveRepos() {
  const requested = (process.env.REPOS ?? defaultRepoIds.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const expanded = requested.flatMap((item) => {
    if (item === 'all') return [...knownRepos.keys()];
    if (item === 'primary') return [...knownRepos].filter(([, repo]) => repo.group === 'primary').map(([id]) => id);
    if (item === 'secondary') return [...knownRepos].filter(([, repo]) => repo.group === 'secondary').map(([id]) => id);
    if (item === 'references') return [...knownRepos].filter(([, repo]) => repo.group === 'reference').map(([id]) => id);
    return [item];
  });
  return [...new Set(expanded)].map((id) => {
    const known = knownRepos.get(id);
    if (!known) throw new Error(`Unknown repo id "${id}". Known ids: ${[...knownRepos.keys()].join(', ')}`);
    return {
      id,
      source: known.source,
      group: known.group,
      copyName: `det-matrix-${safeName(id)}`,
      get copyPath() {
        return path.join(workRoot, this.copyName);
      },
    };
  });
}

function parseCliArgs(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { help: true };
  }
  return {
    error: `Unsupported argument(s): ${argv.join(' ')}. Configure this runner with environment variables instead of argv flags.`,
  };
}

function usage() {
  return [
    'Usage: node scripts/run-deterministic-layer-matrix.mjs',
    '',
    'This deterministic benchmark runner is configured with environment variables, not argv flags.',
    '',
    'Common environment variables:',
    '  REPOS=cotx-engine,fastmcp       Comma-separated repo ids, or all/primary/secondary/references',
    '  OUT_DIR=/abs/path               Result directory',
    '  WORK_ROOT=/abs/path             Copied workdir root',
    '  COTX_CLI=/abs/path/dist/index.js',
    '  DRY_RUN=1                       Emit not-run matrix rows without repo mutation or compile',
    '  REUSE_COPIES=1                  Reuse existing copied workdirs with .cotx output',
    '  SKIP_GITNEXUS=1                 Skip GitNexus analyze/query comparator rows',
    '  RUN_CHANGE_WORKFLOW=1           Execute bounded review-change/plan-change probes',
    '  FAIL_ON_GAP=1                   Exit non-zero after writing artifacts when any matrix row is a gap',
    '',
    'Timeout variables: COPY_TIMEOUT_MS, COMPILE_TIMEOUT_MS, GITNEXUS_ANALYZE_TIMEOUT_MS, QUERY_TIMEOUT_MS, CHANGE_TIMEOUT_MS.',
  ].join('\n');
}

function processRepo(repo) {
  console.log(`[det-matrix] ${repo.id}`);
  if (dryRun) {
    pushDryRunRows(repo);
    return;
  }

  if (!fs.existsSync(repo.source)) {
    pushGapRows(repo, `source path does not exist: ${repo.source}`);
    return;
  }

  const copy = reuseExistingCopies && artifactExists(repo, '.cotx/v2/truth.lbug')
    ? logCommand({ cwd: repo.copyPath, command: 'reuse existing copied workdir with .cotx/v2/truth.lbug', ok: true, seconds: 0 })
    : syncCopy(repo);
  if (!copy.ok) {
    pushGapRows(repo, `copy failed: ${copy.error ?? copy.stderr}`);
    return;
  }

  const changeState = repo.group === 'pr-fixture' && !reuseExistingCopies
    ? materializePrFixtureDiff(repo)
    : { ok: true };
  if (!changeState.ok) {
    pushGapRows(repo, `PR fixture change-state preparation failed: ${changeState.error ?? changeState.stderr}`);
    return;
  }

  const compile = reuseExistingCopies
    ? logCommand({ cwd: repo.copyPath, command: 'reuse existing clean cotx compile output', ok: true, seconds: 0 })
    : run('node', [cotxCli, 'compile'], repo.copyPath, compileTimeoutMs);
  if (!compile.ok) {
    pushGapRows(repo, `cotx compile failed: ${compile.error ?? compile.stderr}`);
    return;
  }

  const status = statusCotx(repo);
  const analyze = skipGitNexus
    ? { ok: false, seconds: 0, command: 'gitnexus analyze skipped by SKIP_GITNEXUS=1', skipped: true }
    : run('gitnexus', ['analyze', '--force', '--skip-agents-md', '--skip-git', repo.copyPath], repo.copyPath, analyzeTimeoutMs);

  addCodeGraphRows(repo, compile, analyze, status);
  addTypedGraphRows(repo, analyze);
  addModuleRows(repo, analyze, status);
  addSemanticRows(repo, analyze, status);
  addRouteToolProcessRows(repo, analyze);
  addQualityProbeRows(repo, analyze);
  addDecisionRows(repo);
  addArchitectureRows(repo);
  addChangeRows(repo);
}

function addCodeGraphRows(repo, compile, analyze, status) {
  const cotxNodes = countCotx(repo, 'MATCH (n:CodeNode) RETURN count(n) AS n');
  const cotxAllNodes = countCotx(repo, 'MATCH (n) RETURN count(n) AS n');
  const cotxSymbolLike = sumCounts(
    countCotx,
    repo,
    Object.fromEntries(symbolLikeLabels.map((label) => [
      label,
      `MATCH (n:CodeNode) WHERE n.label = '${label}' RETURN count(n) AS n`,
    ])),
  );
  const cotxRelations = countCotx(repo, 'MATCH ()-[r:CodeRelation]->() RETURN count(r) AS n');
  const gitNodes = analyze.ok ? countGitNexus(repo, 'MATCH (n) RETURN count(n) AS n') : null;
  const gitSymbolLike = analyze.ok
    ? sumCounts(
        countGitNexus,
        repo,
        Object.fromEntries(symbolLikeLabels.map((label) => [
          label,
          `MATCH (n:${label}) RETURN count(n) AS n`,
        ])),
      )
    : null;
  const gitRelations = analyze.ok ? countGitNexus(repo, 'MATCH ()-[r:CodeRelation]->() RETURN count(r) AS n') : null;

  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'code graph / CodeRelation',
    product: 'cotx',
    status: cotxNodes.ok && cotxRelations.ok ? 'ok' : 'gap',
    primary: cotxNodes.n,
    relations: cotxRelations.n,
    compile_seconds: compile.seconds,
    compiled_at: status.compiled_at,
    command: `node ${cotxCli} compile`,
    details: mergeDetails(cotxNodes, cotxRelations),
    notes: 'cotx CodeNode count; compare with diagnostic cotx-all-nodes and symbol-like rows before making all-node claims',
  });
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'code graph / CodeRelation',
    product: 'gitnexus',
    status: gitNexusStatus(analyze, gitNodes, gitRelations),
    primary: gitNodes?.n ?? null,
    relations: gitRelations?.n ?? null,
    analyze_seconds: analyze.seconds,
    command: analyze.command,
    reason: gitNexusReason(analyze, gitNodes, gitRelations),
    notes: 'GitNexus all-node count via MATCH (n); GitNexus has no CodeNode table here, so use symbol-like diagnostic row for code-symbol comparison',
  });
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'code graph / CodeRelation',
    product: 'cotx-all-nodes',
    status: cotxAllNodes.ok ? 'ok' : 'gap',
    primary: cotxAllNodes.n,
    command: "node cotx cypher 'MATCH (n) RETURN count(n) AS n'",
    notes: 'Diagnostic normalization row: cotx all graph nodes, not the canonical CodeNode truth row',
    reason: cotxAllNodes.ok ? undefined : cotxAllNodes.error,
  });
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'code graph / CodeRelation',
    product: 'cotx-symbol-like',
    status: cotxSymbolLike.ok ? 'ok' : 'gap',
    primary: cotxSymbolLike.total,
    details: { labels: cotxSymbolLike.details, notes: cotxSymbolLike.notes },
    notes: 'Diagnostic normalization row: selected CodeNode labels comparable to GitNexus typed symbol labels',
  });
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'code graph / CodeRelation',
    product: 'gitnexus-symbol-like',
    status: gitNexusStatus(analyze, gitSymbolLike),
    primary: gitSymbolLike?.total ?? null,
    details: { labels: gitSymbolLike?.details, notes: gitSymbolLike?.notes ?? [] },
    reason: gitNexusReason(analyze, gitSymbolLike),
    notes: 'Diagnostic normalization row: selected GitNexus typed labels excluding all-node File/Folder/Section/Community/Process structure',
  });
}

function addTypedGraphRows(repo, analyze) {
  const typedLabels = {
    Function: 'MATCH (n:Function) RETURN count(n) AS n',
    Class: 'MATCH (n:Class) RETURN count(n) AS n',
    Method: 'MATCH (n:Method) RETURN count(n) AS n',
    Interface: 'MATCH (n:Interface) RETURN count(n) AS n',
    Struct: 'MATCH (n:Struct) RETURN count(n) AS n',
    Enum: 'MATCH (n:Enum) RETURN count(n) AS n',
    Trait: 'MATCH (n:Trait) RETURN count(n) AS n',
  };
  const typedRelations = {
    CALLS: "MATCH ()-[r:CodeRelation {type:'CALLS'}]->() RETURN count(r) AS n",
    IMPORTS: "MATCH ()-[r:CodeRelation {type:'IMPORTS'}]->() RETURN count(r) AS n",
    EXTENDS: "MATCH ()-[r:CodeRelation {type:'EXTENDS'}]->() RETURN count(r) AS n",
    IMPLEMENTS: "MATCH ()-[r:CodeRelation {type:'IMPLEMENTS'}]->() RETURN count(r) AS n",
    HAS_METHOD: "MATCH ()-[r:CodeRelation {type:'HAS_METHOD'}]->() RETURN count(r) AS n",
    HAS_PROPERTY: "MATCH ()-[r:CodeRelation {type:'HAS_PROPERTY'}]->() RETURN count(r) AS n",
    OVERRIDES: "MATCH ()-[r:CodeRelation {type:'OVERRIDES'}]->() RETURN count(r) AS n",
    ACCESSES: "MATCH ()-[r:CodeRelation {type:'ACCESSES'}]->() RETURN count(r) AS n",
  };
  const cotxTyped = sumCounts(countCotx, repo, typedLabels);
  const cotxTypedRelations = sumCounts(countCotx, repo, typedRelations);
  const gitTyped = analyze.ok ? sumCounts(countGitNexus, repo, typedLabels) : null;
  const gitTypedRelations = analyze.ok ? sumCounts(countGitNexus, repo, typedRelations) : null;
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'typed nodes / CodeRelation',
    product: 'cotx',
    status: cotxTyped.ok && cotxTypedRelations.ok ? 'ok' : 'gap',
    primary: cotxTyped.total,
    relations: cotxTypedRelations.total,
    details: { nodes: cotxTyped.details, relations: cotxTypedRelations.details, notes: [...cotxTyped.notes, ...cotxTypedRelations.notes] },
  });
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'typed nodes / CodeRelation',
    product: 'gitnexus',
    status: gitNexusStatus(analyze, gitTyped, gitTypedRelations),
    primary: gitTyped?.total ?? null,
    relations: gitTypedRelations?.total ?? null,
    details: { nodes: gitTyped?.details, relations: gitTypedRelations?.details, notes: [...(gitTyped?.notes ?? []), ...(gitTypedRelations?.notes ?? [])] },
    reason: gitNexusReason(analyze, gitTyped, gitTypedRelations),
  });
}

function addModuleRows(repo, analyze, status) {
  const community = analyze.ok ? countGitNexus(repo, 'MATCH (n:Community) RETURN count(n) AS n') : null;
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'modules',
    product: 'cotx',
    status: status.modules === null ? 'gap' : 'ok',
    primary: status.modules,
    relations: community?.n ?? null,
    notes: 'cotx status module count; relations column carries GitNexus community count when available',
  });
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'modules',
    product: 'gitnexus',
    status: gitNexusStatus(analyze, community),
    primary: community?.n ?? null,
    reason: gitNexusReason(analyze, community),
  });
}

function addSemanticRows(repo, analyze, status) {
  for (const [layer, value] of [['concepts', status.concepts], ['contracts', status.contracts], ['flows', status.flows]]) {
    pushRow({
      repo: repo.id,
      source: repo.source,
      workdir: repo.copyPath,
      layer,
      product: 'cotx',
      status: value === null ? 'gap' : 'ok',
      primary: value,
      evidence: 'cotx status',
    });
    if (layer === 'flows') {
      const gitProcess = analyze.ok ? countGitNexus(repo, 'MATCH (n:Process) RETURN count(n) AS n') : null;
      pushRow({
        repo: repo.id,
        source: repo.source,
        workdir: repo.copyPath,
        layer,
        product: 'gitnexus',
        status: gitNexusStatus(analyze, gitProcess),
        primary: gitProcess?.n ?? null,
        notes: 'GitNexus Process used as flow comparator',
        reason: gitNexusReason(analyze, gitProcess),
      });
    } else {
      pushRow(notApplicable(repo, layer, 'gitnexus', `No direct GitNexus ${layer} layer comparator`));
    }
  }
}

function addRouteToolProcessRows(repo, analyze) {
  const definitions = [
    ['routes', 'Route', 'HANDLES_ROUTE'],
    ['tools', 'Tool', 'HANDLES_TOOL'],
    ['processes', 'Process', 'STEP_IN_PROCESS'],
  ];
  for (const [layer, label, relation] of definitions) {
    const cotxNodes = countCotx(repo, `MATCH (n:${label}) RETURN count(n) AS n`);
    const cotxRelations = countCotx(repo, `MATCH ()-[r:CodeRelation {type:'${relation}'}]->() RETURN count(r) AS n`);
    const gitNodes = analyze.ok ? countGitNexus(repo, `MATCH (n:${label}) RETURN count(n) AS n`) : null;
    const gitRelations = analyze.ok ? countGitNexus(repo, `MATCH ()-[r:CodeRelation {type:'${relation}'}]->() RETURN count(r) AS n`) : null;
    pushRow({
      repo: repo.id,
      source: repo.source,
      workdir: repo.copyPath,
      layer,
      product: 'cotx',
      status: cotxNodes.ok && cotxRelations.ok ? 'ok' : 'gap',
      primary: cotxNodes.n,
      relations: cotxRelations.n,
      details: mergeDetails(cotxNodes, cotxRelations),
    });
    pushRow({
      repo: repo.id,
      source: repo.source,
      workdir: repo.copyPath,
      layer,
      product: 'gitnexus',
      status: gitNexusStatus(analyze, gitNodes, gitRelations),
      primary: gitNodes?.n ?? null,
      relations: gitRelations?.n ?? null,
      details: mergeDetails(gitNodes, gitRelations),
      reason: gitNexusReason(analyze, gitNodes, gitRelations),
    });
  }
}

function addDecisionRows(repo) {
  const doctrinePresent = artifactExists(repo, '.cotx/doctrine/compiled.yaml');
  const rulesPresent = artifactExists(repo, '.cotx/v2/rules.db');
  const canonical = run('node', [cotxCli, 'canonical-paths'], repo.copyPath, 60_000);
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'decision facts / doctrine / canonical paths',
    product: 'cotx',
    status: doctrinePresent && rulesPresent && canonical.ok ? 'ok' : 'gap',
    primary: Number(doctrinePresent) + Number(rulesPresent) + Number(canonical.ok),
    details: { doctrinePresent, rulesPresent, canonicalPathsSeconds: canonical.seconds },
    command: canonical.command,
    reason: canonical.ok ? undefined : canonical.error ?? canonical.stderr,
  });
  pushRow(notApplicable(repo, 'decision facts / doctrine / canonical paths', 'gitnexus', 'No direct GitNexus decision/doctrine/canonical paths layer comparator'));
}

function addArchitectureRows(repo) {
  const architectureDataFiles = countFiles(repo, '.cotx/architecture', (file) => file.endsWith('/data.yaml') || file.endsWith('/workspace.json'));
  const architectureDiagrams = countFiles(repo, '.cotx/architecture', (file) => file.endsWith('/diagram.mmd') || file.endsWith('.drawio') || file.endsWith('.d2'));
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'architecture workspace / C4-style hierarchy / views',
    product: 'cotx',
    status: architectureDataFiles > 0 ? 'ok' : 'gap',
    primary: architectureDataFiles,
    relations: architectureDiagrams,
    details: { dataFiles: architectureDataFiles, diagramFiles: architectureDiagrams },
  });
  const ommFiles = countFiles(repo, '.', (file) => file.endsWith('.omm'));
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'architecture workspace / C4-style hierarchy / views',
    product: 'oh-my-mermaid',
    status: ommFiles > 0 ? 'ok' : 'not-applicable',
    primary: ommFiles,
    reason: ommFiles > 0 ? undefined : 'No .omm files in copied repo; oh-my-mermaid is only applicable where .omm artifacts exist or its external runner is provided',
  });
  pushRow(notApplicable(repo, 'architecture workspace / C4-style hierarchy / views', 'gitnexus', 'GitNexus has communities/processes but no direct cotx architecture workspace/C4 view comparator'));
}

function addChangeRows(repo) {
  if (!runChangeWorkflow) {
    pushRow({
      repo: repo.id,
      source: repo.source,
      workdir: repo.copyPath,
      layer: 'change impact / review-change / plan-change',
      product: 'cotx',
      status: 'not-run',
      reason: 'RUN_CHANGE_WORKFLOW=1 not set; avoids known large-repo plan-change timeout path during structural matrix runs',
    });
  } else {
    ensureGitBaseline(repo);
    const review = run('node', [cotxCli, 'review-change'], repo.copyPath, changeTimeoutMs);
    const planTarget = choosePlanTarget(repo);
    const plan = run('node', [cotxCli, 'plan-change', planTarget, '--intent', 'deterministic matrix probe'], repo.copyPath, changeTimeoutMs);
    pushRow({
      repo: repo.id,
      source: repo.source,
      workdir: repo.copyPath,
      layer: 'change impact / review-change / plan-change',
      product: 'cotx',
      status: review.ok && plan.ok ? 'ok' : 'gap',
      primary: Number(review.ok) + Number(plan.ok),
      notes: changeWorkflowNotes(repo, planTarget),
      details: {
        reviewSeconds: review.seconds,
        planSeconds: plan.seconds,
        planTarget,
        reviewSurface: repo.group === 'pr-fixture' ? 'materialized PR fixture diff' : 'empty-baseline no-diff surface',
        reviewError: review.ok ? undefined : review.error ?? review.stderr,
        planError: plan.ok ? undefined : plan.error ?? plan.stderr,
      },
      commands: [review.command, plan.command],
    });
  }
  pushRow(notApplicable(repo, 'change impact / review-change / plan-change', 'gitnexus', 'GitNexus impact is available, but cotx review-change/plan-change workflow has no direct GitNexus comparator in this matrix'));
  const codeReviewGraphApplicable = repo.group === 'pr-fixture' || repo.id === 'code-review-graph';
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'change impact / review-change / plan-change',
    product: 'code-review-graph',
    status: codeReviewGraphApplicable ? 'not-run' : 'not-applicable',
    reason: codeReviewGraphApplicable
      ? 'Direct comparator applies via code-review-graph build plus detect-changes, but it is external to this deterministic cotx matrix; record isolated runner evidence before treating it as comparable'
      : 'Local reference applies only to PR/change fixtures or the code-review-graph target',
  });
}

function addQualityProbeRows(repo, analyze) {
  if (skipGitNexus || analyze.skipped) {
    pushRow({
      repo: repo.id,
      source: repo.source,
      workdir: repo.copyPath,
      layer: 'quality probes / direct inspection',
      product: 'cotx-vs-gitnexus',
      status: 'not-run',
      reason: 'SKIP_GITNEXUS=1; direct-inspection comparator probes require both cotx and GitNexus query surfaces',
    });
    return;
  }
  if (!analyze.ok) {
    pushRow({
      repo: repo.id,
      source: repo.source,
      workdir: repo.copyPath,
      layer: 'quality probes / direct inspection',
      product: 'cotx-vs-gitnexus',
      status: 'gap',
      reason: analyze.error ?? analyze.stderr ?? 'GitNexus analyze failed before direct-inspection probes could run',
    });
    return;
  }

  const record = {
    repo: repo.id,
    quality_probes: runQualityProbes(repo.id, repo.copyPath, {
      countCotx(_repoPath, query) {
        return countCotx(repo, query).n;
      },
      countGitNexus(_repoName, _repoPath, query) {
        return countGitNexus(repo, query).n;
      },
      queryRowCotx(_repoPath, query) {
        return queryRowCotx(repo, query);
      },
      queryRowGitNexus(_repoName, _repoPath, query) {
        return queryRowGitNexus(repo, query);
      },
    }),
  };
  const summaryLines = formatQualityProbeSummary([record]).map((line) => line.replace(/^- /, ''));
  if (summaryLines.length === 0) return;

  qualityProbeRecords.push(record);
  pushRow({
    repo: repo.id,
    source: repo.source,
    workdir: repo.copyPath,
    layer: 'quality probes / direct inspection',
    product: 'cotx-vs-gitnexus',
    ...summarizeQualityProbeRecord(record, summaryLines),
  });
}

export function summarizeQualityProbeRecord(record, summaryLines) {
  const verdicts = (record.quality_probes?.verdicts ?? [])
    .filter((probe) => probe.kind === 'direct-inspection-probe');
  const renderedSummaryLines = summaryLines ?? verdicts.map((probe) => (
    formatQualityProbeSummary([{ repo: record.repo, quality_probes: { verdicts: [probe] } }])[0]?.replace(/^- /, '')
  )).filter(Boolean);
  const comparativeIssues = verdicts.filter((probe) => probe.classification === 'bug' || probe.classification === 'gitnexus-better');
  const sharedTruthMisses = verdicts.filter((probe) => probe.classification === 'both-miss');

  return {
    status: comparativeIssues.length > 0 ? 'gap' : 'ok',
    primary: comparativeIssues.length,
    details: {
      notes: renderedSummaryLines,
      comparative_issues: comparativeIssues.map((probe) => ({
        id: probe.id,
        classification: probe.classification,
        verdict: probe.verdict,
      })),
      shared_truth_misses: sharedTruthMisses.map((probe) => ({
        id: probe.id,
        classification: probe.classification,
        verdict: probe.verdict,
      })),
      probes_run: verdicts.length,
    },
    notes: comparativeIssues.length > 0
      ? `${comparativeIssues.length} cotx-vs-gitnexus direct-inspection issue(s); inspect quality probe notes below`
      : sharedTruthMisses.length > 0
        ? `${sharedTruthMisses.length} shared source-truth miss(es); not counted against cotx-vs-gitnexus parity`
        : 'Direct-inspection probes passed or beat GitNexus where applicable',
  };
}

function pushDryRunRows(repo) {
  for (const layer of layers) {
    pushRow({
      repo: repo.id,
      source: repo.source,
      workdir: repo.copyPath,
      layer,
      product: 'cotx',
      status: 'not-run',
      reason: 'DRY_RUN=1 command plan only; no repo mutation or compile executed',
    });
    if (gitNexusLayerComparable(layer)) {
      pushRow({
        repo: repo.id,
        source: repo.source,
        workdir: repo.copyPath,
        layer,
        product: 'gitnexus',
        status: skipGitNexus ? 'not-run' : 'not-run',
        reason: skipGitNexus ? 'SKIP_GITNEXUS=1' : 'DRY_RUN=1 command plan only; gitnexus analyze not executed',
      });
    } else if (layer === 'architecture workspace / C4-style hierarchy / views') {
      pushRow(notApplicable(repo, layer, 'gitnexus', 'GitNexus has no direct cotx architecture workspace/C4 view comparator'));
      pushRow({ ...notApplicable(repo, layer, 'oh-my-mermaid', 'oh-my-mermaid applies only to recursive documentation/.omm artifacts'), status: 'not-run' });
    } else if (layer === 'change impact / review-change / plan-change') {
      pushRow(notApplicable(repo, layer, 'gitnexus', 'GitNexus impact is not a direct cotx review-change/plan-change comparator'));
      pushRow({ ...notApplicable(repo, layer, 'code-review-graph', 'code-review-graph applies only to PR/delta review fixtures or its own target'), status: 'not-run' });
    } else {
      pushRow(notApplicable(repo, layer, 'gitnexus', `No direct GitNexus ${layer} layer comparator`));
    }
  }
}

function pushGapRows(repo, reason) {
  for (const layer of layers) {
    pushRow({ repo: repo.id, source: repo.source, workdir: repo.copyPath, layer, product: 'cotx', status: 'gap', reason });
    if (gitNexusLayerComparable(layer)) {
      pushRow({ repo: repo.id, source: repo.source, workdir: repo.copyPath, layer, product: 'gitnexus', status: 'gap', reason });
    }
  }
}

function gitNexusLayerComparable(layer) {
  return new Set([
    'code graph / CodeRelation',
    'typed nodes / CodeRelation',
    'modules',
    'flows',
    'routes',
    'tools',
    'processes',
  ]).has(layer);
}

function syncCopy(repo) {
  fs.rmSync(repo.copyPath, { recursive: true, force: true });
  fs.mkdirSync(repo.copyPath, { recursive: true });
  const source = repo.source.endsWith(path.sep) ? repo.source : `${repo.source}${path.sep}`;
  const args = [
    '-a',
    '--delete',
    '--exclude', '.cotx',
    '--exclude', 'node_modules',
    '--exclude', 'dist',
    '--exclude', 'build',
    '--exclude', 'target',
    '--exclude', '.venv',
    '--exclude', '.ruff_cache',
    '--exclude', '.mypy_cache',
    '--exclude', '__pycache__',
    source,
    repo.copyPath,
  ];
  if (repo.group !== 'pr-fixture') {
    args.splice(2, 0, '--exclude', '.git');
  }
  return run('rsync', args, outDir, copyTimeoutMs);
}

function materializePrFixtureDiff(repo) {
  const base = process.env.CHANGE_BASE ?? chooseChangeBase(repo);
  if (!base) {
    return logCommand({
      cwd: repo.copyPath,
      command: 'materialize PR fixture diff',
      ok: false,
      seconds: 0,
      error: 'No CHANGE_BASE provided and none of origin/main, origin/master, upstream/main, upstream/master exists',
    });
  }

  const diff = run('git', ['diff', '--name-only', `${base}...HEAD`], repo.copyPath, 30_000);
  if (!diff.ok) return diff;
  const changedFiles = diff.stdout.trim().split('\n').filter(Boolean);
  if (changedFiles.length === 0) {
    return logCommand({
      cwd: repo.copyPath,
      command: `materialize PR fixture diff against ${base}`,
      ok: false,
      seconds: 0,
      error: `No branch diff files found for ${base}...HEAD`,
    });
  }

  const reset = run('git', ['reset', '--mixed', base], repo.copyPath, 30_000);
  if (!reset.ok) return reset;
  return logCommand({
    cwd: repo.copyPath,
    command: `materialize PR fixture diff against ${base}`,
    ok: true,
    seconds: 0,
    stdout: [`changed_files=${changedFiles.length}`, ...changedFiles.slice(0, 50)].join('\n'),
  });
}

function chooseChangeBase(repo) {
  for (const candidate of ['origin/main', 'origin/master', 'upstream/main', 'upstream/master']) {
    const result = run('git', ['rev-parse', '--verify', `${candidate}^{commit}`], repo.copyPath, 30_000);
    if (result.ok) return candidate;
  }
  return null;
}

function statusCotx(repo) {
  const result = run('node', [cotxCli, 'status'], repo.copyPath, 60_000);
  const text = result.stdout;
  return {
    result,
    compiled_at: matchText(text, /^Last compiled:\s+(.+)$/m),
    modules: matchNumber(text, /^\s*Modules:\s+(\d+)/m),
    concepts: matchNumber(text, /^\s*Concepts:\s+(\d+)/m),
    contracts: matchNumber(text, /^\s*Contracts:\s+(\d+)/m),
    flows: matchNumber(text, /^\s*Flows:\s+(\d+)/m),
  };
}

function countCotx(repo, query) {
  const result = run('node', [cotxCli, 'cypher', query], repo.copyPath, queryTimeoutMs);
  return countFromResult(result);
}

function countGitNexus(repo, query) {
  const result = run('gitnexus', ['cypher', '--repo', repo.copyName, query], repo.copyPath, queryTimeoutMs);
  return countFromResult(result);
}

function countFromResult(result) {
  if (!result.ok && isMissingCypherTable(result)) {
    return { ok: true, n: 0, seconds: result.seconds, note: 'query target table does not exist; recorded as explicit zero-count evidence' };
  }
  const row = result.ok ? firstRow(result) : null;
  return {
    ok: result.ok,
    n: Number(row?.n ?? 0),
    seconds: result.seconds,
    error: result.ok ? undefined : result.error ?? result.stderr,
  };
}

function queryRowCotx(repo, query) {
  const result = run('node', [cotxCli, 'cypher', query], repo.copyPath, queryTimeoutMs);
  return result.ok ? firstRow(result) ?? {} : {};
}

function queryRowGitNexus(repo, query) {
  const result = run('gitnexus', ['cypher', '--repo', repo.copyName, query], repo.copyPath, queryTimeoutMs);
  return result.ok ? firstRow(result) ?? {} : {};
}

function sumCounts(counter, repo, entries) {
  let total = 0;
  const details = {};
  const notes = [];
  let ok = true;
  for (const [key, query] of Object.entries(entries)) {
    const count = counter(repo, query);
    details[key] = count.n;
    if (count.note) notes.push(`${key}: ${count.note}`);
    ok = ok && count.ok;
    total += count.n;
  }
  return { ok, total, details, notes };
}

function run(cmd, args, cwd, timeoutMs) {
  const started = Date.now();
  const command = `${cmd} ${args.map(shellQuote).join(' ')}`;
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
    });
    return logCommand({ cwd, command, ok: true, seconds: secondsSince(started), stdout: stdout.slice(0, 4000) });
  } catch (error) {
    return logCommand({
      cwd,
      command,
      ok: false,
      seconds: secondsSince(started),
      error: error instanceof Error ? error.message : String(error),
      stdout: error.stdout?.toString?.().slice(0, 4000) ?? '',
      stderr: error.stderr?.toString?.().slice(0, 4000) ?? '',
    });
  }
}

function logCommand(record) {
  commandLog.push(record);
  fs.appendFileSync(commandLogPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function firstRow(result) {
  const json = parseJson(result.stdout);
  if (json?.rows?.[0]) return json.rows[0];
  if (json?.markdown) return firstMarkdownRow(json.markdown);
  return null;
}

function firstMarkdownRow(markdown) {
  const lines = String(markdown).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const headers = lines[0].split('|').map((cell) => cell.trim()).filter(Boolean);
  const values = lines[2].split('|').map((cell) => cell.trim()).filter(Boolean);
  return Object.fromEntries(headers.map((header, index) => [header, parseValue(values[index])]));
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function parseValue(value) {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function isMissingCypherTable(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`;
  return text.includes('Table ') && text.includes(' does not exist');
}

function artifactExists(repo, relativePath) {
  return fs.existsSync(path.join(repo.copyPath, relativePath));
}

function countFiles(repo, relativeDir, predicate = () => true) {
  const dir = path.join(repo.copyPath, relativeDir);
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(repo.copyPath, full);
    if (entry.isDirectory()) count += countFiles(repo, rel, predicate);
    else if (predicate(full)) count += 1;
  }
  return count;
}

function ensureGitBaseline(repo) {
  const head = run('git', ['rev-parse', '--verify', 'HEAD'], repo.copyPath, 30_000);
  if (head.ok) return;
  run('git', ['init'], repo.copyPath, 30_000);
  run('git', ['-c', 'user.email=det-matrix@example.invalid', '-c', 'user.name=det-matrix', 'commit', '--allow-empty', '-m', 'det-matrix-empty-baseline'], repo.copyPath, 30_000);
}

function choosePlanTarget(repo) {
  for (const candidate of ['README.md', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    if (fs.existsSync(path.join(repo.copyPath, candidate))) return candidate;
  }
  return '.';
}

function changeWorkflowNotes(repo, planTarget) {
  if (repo.group === 'pr-fixture') {
    return `PR fixture preserves git history and materializes a branch diff before review-change; plan-change ${planTarget} remains a planning probe.`;
  }
  return `${repo.group} repo copy excludes .git; the harness may initialize an empty baseline, so review-change is a no-diff surface, not PR fixture review evidence. plan-change ${planTarget} remains a planning probe.`;
}

function pushRow(row) {
  rows.push(row);
  fs.appendFileSync(outJsonl, `${JSON.stringify(row)}\n`, 'utf8');
}

function notApplicable(repo, layer, product, reason) {
  return { repo: repo.id, source: repo.source, workdir: repo.copyPath, layer, product, status: 'not-applicable', reason };
}

function gitNexusStatus(analyze, ...counts) {
  if (skipGitNexus || analyze.skipped) return 'not-run';
  if (!analyze.ok) return 'gap';
  if (counts.every((count) => count?.ok)) return 'ok';
  return 'gap';
}

function gitNexusReason(analyze, ...counts) {
  if (skipGitNexus || analyze.skipped) return 'SKIP_GITNEXUS=1';
  if (!analyze.ok) return analyze.error ?? analyze.stderr;
  const failed = counts.find((count) => count && !count.ok);
  return failed?.error;
}

function mergeDetails(...counts) {
  const notes = counts.map((count) => count?.note).filter(Boolean);
  return notes.length > 0 ? { notes } : undefined;
}

function writeMarkdown() {
  const lines = [
    '# Deterministic Layer Matrix',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Workdir root: ${workRoot}`,
    `JSONL: ${finalJsonl}`,
    `Command log: ${finalCommandLogPath}`,
    '',
    '## Key Findings',
    '',
    '- The matrix is deterministic-only: cotx compile/status/cypher/canonical-paths are the cotx truth surface, and GitNexus is used only where a direct graph/process/route/tool comparator exists.',
    '- Code graph rows now keep the canonical cotx CodeNode and GitNexus all-node measurements explicit, plus diagnostic all-node and symbol-like normalization rows to prevent misleading headline comparisons.',
    '- code-review-graph and oh-my-mermaid are recorded as specialized comparators with explicit non-applicable or gap states instead of being forced into unrelated layers.',
    `- RUN_CHANGE_WORKFLOW=${runChangeWorkflow ? '1' : '0'}; change workflow rows ${runChangeWorkflow ? 'were executed with bounded timeouts' : 'were left not-run to avoid known large-repo plan-change timeouts'}.`,
    '',
    '## Recommendation',
    '',
    '- Use this script for focused per-repo proof runs first, then scale REPOS to the primary benchmark set once the focused command log is clean.',
    '- Treat any `gap` row as a deterministic compiler or comparator-surface investigation target, not as grounds for compatibility fallback behavior.',
    '',
    '## Priority Fix List (if applicable)',
    '',
    ...priorityFixLines(),
    '',
    '## Summary',
    '',
    '| Repo | cotx compile s | GitNexus analyze s | cotx CodeNode | GitNexus all nodes | cotx relations | GitNexus relations | gaps | not-run |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const repo of repos) {
    const cotxCode = rows.find((row) => row.repo === repo.id && row.layer === 'code graph / CodeRelation' && row.product === 'cotx');
    const gitCode = rows.find((row) => row.repo === repo.id && row.layer === 'code graph / CodeRelation' && row.product === 'gitnexus');
    const gaps = rows.filter((row) => row.repo === repo.id && row.status === 'gap').length;
    const notRun = rows.filter((row) => row.repo === repo.id && row.status === 'not-run').length;
    lines.push(`| ${repo.id} | ${cotxCode?.compile_seconds ?? ''} | ${gitCode?.analyze_seconds ?? ''} | ${cotxCode?.primary ?? ''} | ${gitCode?.primary ?? ''} | ${cotxCode?.relations ?? ''} | ${gitCode?.relations ?? ''} | ${gaps} | ${notRun} |`);
  }

  lines.push('', '## Layer Matrix', '');
  for (const repo of repos) {
    lines.push(`### ${repo.id}`, '');
    lines.push('| Layer | Product | Status | Primary | Relations | Notes |');
    lines.push('| --- | --- | --- | ---: | ---: | --- |');
    for (const row of rows.filter((item) => item.repo === repo.id)) {
      const notes = rowNotes(row);
      lines.push(`| ${escapeCell(row.layer)} | ${escapeCell(row.product)} | ${escapeCell(row.status)} | ${row.primary ?? ''} | ${row.relations ?? ''} | ${escapeCell(String(notes).slice(0, 220))} |`);
    }
    lines.push('');
  }

  lines.push('## Quality Probes', '');
  if (qualityProbeRecords.length === 0) {
    lines.push('- No direct-inspection probe notes were recorded in this run.');
  } else {
    lines.push(...formatQualityProbeSummary(qualityProbeRecords));
  }

  lines.push('## Failure And Gap Notes', '');
  const gapRows = rows.filter((row) => row.status === 'gap');
  if (gapRows.length === 0) {
    lines.push('- No gap rows were recorded.');
  } else {
    for (const row of gapRows) {
      lines.push(`- ${row.repo} / ${row.layer} / ${row.product}: ${row.reason ?? row.details?.planError ?? row.details?.reviewError ?? 'gap recorded'}`);
    }
  }

  lines.push('', '## Commands', '');
  if (commandLog.length === 0) {
    lines.push('- No commands executed.');
  } else {
    for (const record of commandLog) {
      const status = record.ok ? 'ok' : 'failed';
      const detail = record.ok ? '' : ` error=${record.error ?? record.stderr ?? ''}`;
      lines.push(`- ${status} ${record.seconds}s cwd=${record.cwd} cmd=\`${record.command}\`${detail}`.slice(0, 1200));
    }
  }

  fs.writeFileSync(outMd, `${lines.join('\n')}\n`, 'utf8');
  fs.renameSync(outJsonl, finalJsonl);
  fs.renameSync(outMd, finalMd);
  fs.renameSync(commandLogPath, finalCommandLogPath);
  console.log(`wrote ${finalJsonl}`);
  console.log(`wrote ${finalMd}`);
  console.log(`wrote ${finalCommandLogPath}`);

  if (failOnGap && gapRows.length > 0) {
    console.error(`[det-matrix] FAIL_ON_GAP=1 and ${gapRows.length} gap row(s) were recorded.`);
    for (const row of gapRows.slice(0, 10)) {
      console.error(`- ${row.repo} / ${row.layer} / ${row.product}: ${row.reason ?? row.details?.planError ?? row.details?.reviewError ?? 'gap recorded'}`);
    }
    process.exitCode = 1;
  }
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(outJsonl, '', 'utf8');
  fs.writeFileSync(commandLogPath, '', 'utf8');

  if (!dryRun && !fs.existsSync(cotxCli)) {
    throw new Error(`COTX_CLI does not exist: ${cotxCli}. Build first or set COTX_CLI.`);
  }

  for (const repo of repos) {
    processRepo(repo);
  }

  writeMarkdown();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function priorityFixLines() {
  const gapRows = rows.filter((row) => row.status === 'gap');
  if (gapRows.length === 0) return ['- No immediate priority fixes from this run.'];
  return gapRows.slice(0, 12).map((row) => `- ${row.repo}: ${row.layer} / ${row.product} -> ${row.reason ?? 'gap recorded'}`);
}

function rowNotes(row) {
  const detailNotes = Array.isArray(row.details?.notes) ? row.details.notes.join('; ') : '';
  if (row.reason) return row.reason;
  if (row.notes) return row.notes;
  if (detailNotes) return detailNotes;
  return row.command ?? '';
}

function matchText(text, regex) {
  return regex.exec(text)?.[1] ?? null;
}

function matchNumber(text, regex) {
  const value = regex.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function secondsSince(started) {
  return Number(((Date.now() - started) / 1000).toFixed(3));
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(String(value))) return String(value);
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}
