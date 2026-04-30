const CLASSIFICATIONS = new Set([
  'cotx-better',
  'gitnexus-better',
  'both-valid',
  'both-miss',
  'bug',
  'unsupported',
]);

const commonProbeDefinitions = [
  countComparisonProbe({
    id: 'relation_type_coverage',
    title: 'Relation type coverage',
    cotxQuery: 'MATCH ()-[r:CodeRelation]->() RETURN count(DISTINCT r.type) AS n',
    gitnexusQuery: 'MATCH ()-[r:CodeRelation]->() RETURN count(DISTINCT r.type) AS n',
    legacyCotxKey: 'cotx_relation_types',
    legacyGitNexusKey: 'gitnexus_relation_types',
    classificationBasis: 'aggregate-count',
  }),
  countComparisonProbe({
    id: 'label_type_coverage',
    title: 'Label type coverage',
    cotxQuery: 'MATCH (n:CodeNode) RETURN count(DISTINCT n.label) AS n',
    gitnexusQuery: 'MATCH (n) RETURN count(DISTINCT labels(n)) AS n',
    legacyCotxKey: 'cotx_label_types',
    legacyGitNexusKey: 'gitnexus_label_types',
    classificationBasis: 'aggregate-count',
  }),
];

const repoProbeDefinitions = new Map([
  [
    'fastmcp',
    [
      countComparisonProbe({
        id: 'fastmcp_route_count',
        title: 'FastMCP route count',
        cotxQuery: "MATCH (n:CodeNode {label:'Route'}) RETURN count(n) AS n",
        gitnexusQuery: 'MATCH (n:Route) RETURN count(n) AS n',
        classificationBasis: 'benchmark-route-count',
      }),
      countComparisonProbe({
        id: 'fastmcp_tool_count',
        title: 'FastMCP tool count',
        cotxQuery: "MATCH (n:CodeNode {label:'Tool'}) RETURN count(n) AS n",
        gitnexusQuery: 'MATCH (n:Tool) RETURN count(n) AS n',
        classificationBasis: 'benchmark-tool-count',
      }),
    ],
  ],
  [
    'github-mcp-server',
    [
      countComparisonProbe({
        id: 'github_mcp_server_go_call_count',
        title: 'github-mcp-server Go call count',
        cotxQuery: "MATCH (f:Function)-[r:CodeRelation {type:'CALLS'}]->(g:Function) RETURN count(r) AS n",
        gitnexusQuery: "MATCH (f:Function)-[r:CodeRelation {type:'CALLS'}]->(g:Function) RETURN count(r) AS n",
        classificationBasis: 'aggregate-call-count',
      }),
      {
        id: 'github_mcp_server_newserver_precision',
        title: 'github-mcp-server NewServer precision',
        run(ctx) {
          const query = "MATCH (f:Function {filePath:'pkg/github/dynamic_tools_test.go', name:'TestDynamicTools_EnableToolset'})-[r:CodeRelation {type:'CALLS'}]->(t:Function) WHERE t.filePath='pkg/github/server.go' AND t.name='NewServer' RETURN count(r) AS calls";
          const cotxCalls = Number(ctx.queryRowCotx(ctx.repoPath, query).calls ?? 0);
          const gitnexusCalls = Number(ctx.queryRowGitNexus(ctx.repoName, ctx.repoPath, query).calls ?? 0);
          const classification = classifyFalsePositiveGuard(cotxCalls, gitnexusCalls);

          return withLegacy({
            id: this.id,
            title: this.title,
            kind: 'direct-inspection-probe',
            classification,
            classification_basis: 'direct-inspection-go-imported-call',
            expected_truth: 'TestDynamicTools_EnableToolset calls imported mcp.NewServer, not local github.NewServer.',
            verdict: classification === 'cotx-better'
              ? 'cotx_does_not_overresolve_mcp_newserver_to_github_newserver'
              : classification === 'both-miss'
                ? 'go_newserver_resolution_missing_in_both'
                : 'go_newserver_resolution_needs_audit',
            score: classification === 'cotx-better' || classification === 'both-valid'
              ? 1
              : classification === 'both-miss'
                ? null
                : 0.5,
            cotx: {
              false_positive_calls: cotxCalls,
            },
            gitnexus: {
              false_positive_calls: gitnexusCalls,
            },
          }, {
            go_newserver_precision: {
              cotx_false_positive_calls: cotxCalls,
              gitnexus_false_positive_calls: gitnexusCalls,
              classification,
            },
          });
        },
      },
      {
        id: 'github_mcp_server_graphql_features_coverage',
        title: 'github-mcp-server GraphQL features coverage',
        run(ctx) {
          const query = "MATCH (f)-[r:CodeRelation {type:'CALLS'}]->(t) WHERE t.filePath='pkg/context/graphql_features.go' AND t.name='GetGraphQLFeatures' RETURN count(r) AS calls";
          const cotxCalls = Number(ctx.queryRowCotx(ctx.repoPath, query).calls ?? 0);
          const gitnexusCalls = Number(ctx.queryRowGitNexus(ctx.repoName, ctx.repoPath, query).calls ?? 0);
          const classification = classifyTruthMatch(cotxCalls === 2, gitnexusCalls === 2);

          return withLegacy({
            id: this.id,
            title: this.title,
            kind: 'direct-inspection-probe',
            classification,
            classification_basis: 'direct-inspection-go-method-call',
            expected_truth: 'BearerAuthTransport.RoundTrip and GraphQLFeaturesTransport.RoundTrip each call ghcontext.GetGraphQLFeatures.',
            verdict: classification === 'bug'
              ? 'go_method_call_edges_missing'
              : classification === 'both-miss'
                ? 'go_method_call_edges_missing_in_both'
              : 'go_method_call_edges_match_direct_inspection',
            score: classification === 'bug' ? 0.5 : classification === 'both-miss' ? null : 1,
            cotx: {
              calls: cotxCalls,
            },
            gitnexus: {
              calls: gitnexusCalls,
            },
          }, {
            go_graphql_features_coverage: {
              cotx_calls: cotxCalls,
              gitnexus_calls: gitnexusCalls,
              classification,
            },
          });
        },
      },
    ],
  ],
  [
    'deer-flow',
    [
      {
        id: 'deer_flow_nextjs_api_routes',
        title: 'deer-flow Next.js API route coverage',
        run(ctx) {
          const routeQuery = "MATCH (r:Route) WHERE r.name='/api/auth/[...all]' OR r.name='/api/memory' OR r.name='/api/memory/[...path]' RETURN count(r) AS routes";
          const handlesQuery = "MATCH (h)-[rel:CodeRelation {type:'HANDLES_ROUTE'}]->(r:Route) WHERE r.name='/api/auth/[...all]' OR r.name='/api/memory' OR r.name='/api/memory/[...path]' RETURN count(rel) AS handles";
          const cotxRoutes = Number(ctx.queryRowCotx(ctx.repoPath, routeQuery).routes ?? 0);
          const gitnexusRoutes = Number(ctx.queryRowGitNexus(ctx.repoName, ctx.repoPath, routeQuery).routes ?? 0);
          const cotxHandles = Number(ctx.queryRowCotx(ctx.repoPath, handlesQuery).handles ?? 0);
          const gitnexusHandles = Number(ctx.queryRowGitNexus(ctx.repoName, ctx.repoPath, handlesQuery).handles ?? 0);
          const cotxMatchesTruth = cotxRoutes === 3 && cotxHandles === 3;
          const gitnexusMatchesTruth = gitnexusRoutes === 3 && gitnexusHandles === 3;
          const classification = classifyTruthMatch(cotxMatchesTruth, gitnexusMatchesTruth);

          return withLegacy({
            id: this.id,
            title: this.title,
            kind: 'direct-inspection-probe',
            classification,
            classification_basis: 'direct-inspection-nextjs-filesystem-routes',
            expected_truth: 'deer-flow frontend defines three Next.js API route files: /api/auth/[...all], /api/memory, and /api/memory/[...path], each with a route handler file.',
            verdict: cotxMatchesTruth
              ? 'cotx_detects_deer_flow_nextjs_api_routes'
              : classification === 'both-miss'
                ? 'deer_flow_nextjs_api_routes_missing_in_both'
                : 'cotx_missing_deer_flow_nextjs_api_routes',
            score: cotxMatchesTruth ? 1 : classification === 'both-miss' ? null : 0.5,
            cotx: {
              routes: cotxRoutes,
              handles: cotxHandles,
            },
            gitnexus: {
              routes: gitnexusRoutes,
              handles: gitnexusHandles,
            },
          }, {
            nextjs_api_routes: {
              cotx_routes: cotxRoutes,
              cotx_handles: cotxHandles,
              gitnexus_routes: gitnexusRoutes,
              gitnexus_handles: gitnexusHandles,
              classification,
            },
          });
        },
      },
    ],
  ],
  [
    'OpenHands',
    [
      {
        id: 'openhands_status_router_coverage',
        title: 'OpenHands FastAPI status router coverage',
        run(ctx) {
          const routeQuery = "MATCH (r:Route) WHERE r.filePath='openhands/app_server/status/status_router.py' RETURN count(r) AS routes";
          const handlesQuery = "MATCH (h)-[rel:CodeRelation {type:'HANDLES_ROUTE'}]->(r:Route) WHERE r.filePath='openhands/app_server/status/status_router.py' RETURN count(rel) AS handles";
          const cotxRoutes = Number(ctx.queryRowCotx(ctx.repoPath, routeQuery).routes ?? 0);
          const gitnexusRoutes = Number(ctx.queryRowGitNexus(ctx.repoName, ctx.repoPath, routeQuery).routes ?? 0);
          const cotxHandles = Number(ctx.queryRowCotx(ctx.repoPath, handlesQuery).handles ?? 0);
          const gitnexusHandles = Number(ctx.queryRowGitNexus(ctx.repoName, ctx.repoPath, handlesQuery).handles ?? 0);
          const cotxMatchesTruth = cotxRoutes === 4 && cotxHandles === 4;
          const gitnexusMatchesTruth = gitnexusRoutes === 4 && gitnexusHandles === 4;
          const classification = classifyTruthMatch(cotxMatchesTruth, gitnexusMatchesTruth);

          return withLegacy({
            id: this.id,
            title: this.title,
            kind: 'direct-inspection-probe',
            classification,
            classification_basis: 'direct-inspection-fastapi-status-routes',
            expected_truth: 'OpenHands status_router.py defines four FastAPI GET routes: /alive, /health, /server_info, and /ready, each with a handler edge.',
            verdict: cotxMatchesTruth
              ? 'cotx_detects_all_openhands_status_routes'
              : classification === 'both-miss'
                ? 'openhands_status_routes_missing_in_both'
                : 'openhands_status_routes_missing',
            score: cotxMatchesTruth ? 1 : classification === 'both-miss' ? null : 0.5,
            cotx: {
              routes: cotxRoutes,
              handles: cotxHandles,
            },
            gitnexus: {
              routes: gitnexusRoutes,
              handles: gitnexusHandles,
            },
          }, {
            openhands_status_router_coverage: {
              cotx_routes: cotxRoutes,
              cotx_handles: cotxHandles,
              gitnexus_routes: gitnexusRoutes,
              gitnexus_handles: gitnexusHandles,
              classification,
            },
          });
        },
      },
    ],
  ],
  [
    'ruff',
    [
      {
        id: 'ruff_generated_range_precision',
        title: 'ruff generated.rs range precision',
        run(ctx) {
          const cotxRange = ctx.queryRowCotx(
            ctx.repoPath,
            "MATCH ()-[r:CodeRelation {type:'CALLS'}]->(t), (m:CodeNode {id:t.id}) WHERE m.filePath='crates/ruff_python_ast/src/generated.rs' AND m.name='range' RETURN count(r) AS calls, count(DISTINCT t.id) AS targets",
          );
          const gitnexusRange = ctx.queryRowGitNexus(
            ctx.repoName,
            ctx.repoPath,
            "MATCH ()-[r:CodeRelation {type:'CALLS'}]->(t) WHERE t.filePath='crates/ruff_python_ast/src/generated.rs' AND t.name='range' RETURN count(r) AS calls, count(DISTINCT t.id) AS targets",
          );
          const cotxCalls = Number(cotxRange.calls ?? 0);
          const cotxTargets = Number(cotxRange.targets ?? 0);
          const gitnexusCalls = Number(gitnexusRange.calls ?? 0);
          const gitnexusTargets = Number(gitnexusRange.targets ?? 0);
          const classification = classifyPrecision(cotxTargets, gitnexusTargets, cotxCalls, gitnexusCalls);
          const verdict = classification === 'cotx-better'
            ? 'cotx_preserves_generated_ast_range_variants'
            : 'gitnexus_equal_or_more_precise';

          return withLegacy({
            id: this.id,
            title: this.title,
            kind: 'direct-inspection-probe',
            classification,
            classification_basis: 'direct-inspection-generated-rust-range',
            expected_truth: 'generated.rs has multiple AST range implementations; distinct target preservation is higher precision than collapsing to one target.',
            verdict,
            score: classification === 'cotx-better' ? 1 : 0.5,
            cotx: {
              calls: cotxCalls,
              distinct_targets: cotxTargets,
            },
            gitnexus: {
              calls: gitnexusCalls,
              distinct_targets: gitnexusTargets,
            },
          }, {
            generated_range_precision: {
              cotx_calls: cotxCalls,
              cotx_distinct_targets: cotxTargets,
              gitnexus_calls: gitnexusCalls,
              gitnexus_distinct_targets: gitnexusTargets,
              verdict,
              classification,
            },
          });
        },
      },
      {
        id: 'ruff_rust_dispatch_depth',
        title: 'ruff Rust dispatch depth',
        run(ctx) {
          const cotxMethodImplements = ctx.countCotx(
            ctx.repoPath,
            "MATCH ()-[r:CodeRelation {type:'METHOD_IMPLEMENTS'}]->() RETURN count(r) AS n",
          );
          const gitnexusMethodImplements = ctx.countGitNexus(
            ctx.repoName,
            ctx.repoPath,
            "MATCH ()-[r:CodeRelation {type:'METHOD_IMPLEMENTS'}]->() RETURN count(r) AS n",
          );
          const classification = classifyCounts(cotxMethodImplements, gitnexusMethodImplements);

          return withLegacy({
            id: this.id,
            title: this.title,
            kind: 'direct-inspection-probe',
            classification,
            classification_basis: 'direct-inspection-rust-trait-impls',
            expected_truth: 'Rust trait impl methods should retain METHOD_IMPLEMENTS edges when owner and method nodes exist.',
            verdict: classification === 'cotx-better'
              ? 'cotx_preserves_method_implements_edges'
              : 'gitnexus_equal_or_more_method_implements_edges',
            score: cotxMethodImplements > gitnexusMethodImplements ? 1 : 0.5,
            cotx: {
              method_implements: cotxMethodImplements,
            },
            gitnexus: {
              method_implements: gitnexusMethodImplements,
            },
          }, {
            rust_dispatch_depth: {
              cotx_method_implements: cotxMethodImplements,
              gitnexus_method_implements: gitnexusMethodImplements,
              classification,
            },
          });
        },
      },
      {
        id: 'ruff_parsed_load_precision',
        title: 'ruff ParsedModule load precision',
        run(ctx) {
          const query = "MATCH (f:Function {filePath:'crates/ruff_db/src/cancellation.rs', name:'is_cancellation_requested'})-[r:CodeRelation {type:'CALLS'}]->(t:Function) WHERE t.filePath='crates/ruff_db/src/parsed.rs' AND t.name STARTS WITH 'lo' AND t.name ENDS WITH 'ad' RETURN count(r) AS calls";
          const cotxCalls = Number(ctx.queryRowCotx(ctx.repoPath, query).calls ?? 0);
          const gitnexusCalls = Number(ctx.queryRowGitNexus(ctx.repoName, ctx.repoPath, query).calls ?? 0);
          const classification = classifyFalsePositiveGuard(cotxCalls, gitnexusCalls);

          return withLegacy({
            id: this.id,
            title: this.title,
            kind: 'direct-inspection-probe',
            classification,
            classification_basis: 'direct-inspection-rust-receiver-call',
            expected_truth: 'CancellationTokenSource::is_cancellation_requested calls AtomicBool::load, not ParsedModule::load.',
            verdict: classification === 'cotx-better'
              ? 'cotx_does_not_overresolve_atomic_load_to_parsed_module'
              : 'parsed_load_resolution_needs_audit',
            score: classification === 'cotx-better' || classification === 'both-valid' ? 1 : 0.5,
            cotx: {
              false_positive_calls: cotxCalls,
            },
            gitnexus: {
              false_positive_calls: gitnexusCalls,
            },
          }, {
            parsed_load_precision: {
              cotx_false_positive_calls: cotxCalls,
              gitnexus_false_positive_calls: gitnexusCalls,
              classification,
            },
          });
        },
      },
    ],
  ],
]);

export function runQualityProbes(repoName, repoPath, tools) {
  const probes = {};
  const verdicts = [];
  const definitions = [
    ...commonProbeDefinitions,
    ...(repoProbeDefinitions.get(repoName) ?? []),
  ];

  for (const definition of definitions) {
    const output = definition.run({ ...tools, repoName, repoPath });
    applyLegacy(probes, output.legacy);
    verdicts.push(output.verdict);
  }

  probes.verdicts = verdicts;
  return probes;
}

export function qualityProbeScoreContributions(record) {
  return (record.quality_probes?.verdicts ?? [])
    .map((probe) => probe.score)
    .filter((score) => typeof score === 'number' && Number.isFinite(score));
}

export function formatQualityProbeSummary(records) {
  return records.flatMap((record) => {
    const verdicts = record.quality_probes?.verdicts ?? [];
    return verdicts
      .filter((probe) => probe.kind !== 'aggregate-count' || probe.classification !== 'both-valid')
      .map((probe) => formatProbeSummaryLine(record.repo, probe));
  });
}

function countComparisonProbe(definition) {
  return {
    ...definition,
    run(ctx) {
      const cotxCount = ctx.countCotx(ctx.repoPath, definition.cotxQuery);
      const gitnexusCount = ctx.countGitNexus(ctx.repoName, ctx.repoPath, definition.gitnexusQuery);
      const classification = definition.classify?.(cotxCount, gitnexusCount) ?? classifyCounts(cotxCount, gitnexusCount);
      const verdict = countVerdict(classification);

      return withLegacy({
        id: definition.id,
        title: definition.title,
        kind: 'aggregate-count',
        classification,
        classification_basis: definition.classificationBasis,
        verdict,
        cotx: {
          count: cotxCount,
        },
        gitnexus: {
          count: gitnexusCount,
        },
        metrics: {
          delta: cotxCount - gitnexusCount,
          ratio: ratio(cotxCount, gitnexusCount),
        },
      }, legacyCountKeys(definition, cotxCount, gitnexusCount));
    },
  };
}

function legacyCountKeys(definition, cotxCount, gitnexusCount) {
  const legacy = {};
  if (definition.legacyCotxKey) legacy[definition.legacyCotxKey] = cotxCount;
  if (definition.legacyGitNexusKey) legacy[definition.legacyGitNexusKey] = gitnexusCount;
  return legacy;
}

function withLegacy(verdict, legacy) {
  assertClassification(verdict.classification, verdict.id);
  return { verdict, legacy };
}

function applyLegacy(probes, legacy) {
  for (const [key, value] of Object.entries(legacy ?? {})) {
    probes[key] = value;
  }
}

function classifyCounts(cotxCount, gitnexusCount) {
  if (cotxCount === gitnexusCount) return 'both-valid';
  if (cotxCount > gitnexusCount) return 'cotx-better';
  return 'gitnexus-better';
}

function classifyPrecision(cotxTargets, gitnexusTargets, cotxCalls, gitnexusCalls) {
  if (cotxTargets > gitnexusTargets) return 'cotx-better';
  if (gitnexusTargets > cotxTargets) return 'gitnexus-better';
  if (cotxCalls === gitnexusCalls) return 'both-valid';
  return cotxCalls > gitnexusCalls ? 'cotx-better' : 'gitnexus-better';
}

function classifyFalsePositiveGuard(cotxFalsePositiveCalls, gitnexusFalsePositiveCalls) {
  if (cotxFalsePositiveCalls === 0 && gitnexusFalsePositiveCalls === 0) return 'both-valid';
  if (cotxFalsePositiveCalls === 0 && gitnexusFalsePositiveCalls > 0) return 'cotx-better';
  if (cotxFalsePositiveCalls > 0 && gitnexusFalsePositiveCalls > 0) return 'both-miss';
  return 'bug';
}

function classifyTruthMatch(cotxMatchesTruth, gitnexusMatchesTruth) {
  if (cotxMatchesTruth && gitnexusMatchesTruth) return 'both-valid';
  if (cotxMatchesTruth) return 'cotx-better';
  if (gitnexusMatchesTruth) return 'gitnexus-better';
  return 'both-miss';
}

function countVerdict(classification) {
  switch (classification) {
    case 'both-valid':
      return 'counts_equal';
    case 'cotx-better':
      return 'cotx_count_higher';
    case 'gitnexus-better':
      return 'gitnexus_count_higher';
    case 'both-miss':
      return 'counts_both_miss_truth';
    default:
      return classification;
  }
}

function assertClassification(classification, probeId) {
  if (!CLASSIFICATIONS.has(classification)) {
    throw new Error(`Probe ${probeId} returned invalid classification: ${classification}`);
  }
}

function ratio(a, b) {
  if (b > 0) return Number((a / b).toFixed(3));
  return a === 0 ? 1 : null;
}

function formatProbeSummaryLine(repo, probe) {
  const cotx = formatProbeSide(probe.cotx);
  const gitnexus = formatProbeSide(probe.gitnexus);
  return `- ${repo} ${probe.id}: ${probe.classification} (${probe.classification_basis}); verdict=${probe.verdict}; cotx ${cotx}; GitNexus ${gitnexus}.`;
}

function formatProbeSide(side) {
  return Object.entries(side ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}
