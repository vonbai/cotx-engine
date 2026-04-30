import { describe, expect, it } from 'vitest';
import {
  formatQualityProbeSummary,
  qualityProbeScoreContributions,
  runQualityProbes,
} from '../../scripts/typed-graph-probes/index.mjs';
import { summarizeQualityProbeRecord } from '../../scripts/run-deterministic-layer-matrix.mjs';

describe('typed graph benchmark probes', () => {
  it('runs common and repo-specific probes from data definitions', () => {
    const qualityProbes = runQualityProbes('fastmcp', '/repos/fastmcp', {
      countCotx(_repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT n.label')) return 10;
        if (query.includes("label:'Route'")) return 6;
        if (query.includes("label:'Tool'")) return 320;
        throw new Error(`unexpected cotx query: ${query}`);
      },
      countGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT labels')) return 10;
        if (query.includes(':Route')) return 6;
        if (query.includes(':Tool')) return 320;
        throw new Error(`unexpected GitNexus query: ${query}`);
      },
      queryRowCotx() {
        throw new Error('fastmcp probe should not run cotx row queries');
      },
      queryRowGitNexus() {
        throw new Error('fastmcp probe should not run GitNexus row queries');
      },
    });

    expect(qualityProbes.cotx_relation_types).toBe(13);
    expect(qualityProbes.gitnexus_label_types).toBe(10);
    expect(qualityProbes.verdicts.map((probe) => probe.id)).toEqual([
      'relation_type_coverage',
      'label_type_coverage',
      'fastmcp_route_count',
      'fastmcp_tool_count',
    ]);
    expect(qualityProbes.verdicts.every((probe) => probe.classification === 'both-valid')).toBe(true);
  });

  it('keeps github-mcp-server Go probes scoreable and classified', () => {
    const qualityProbes = runQualityProbes('github-mcp-server', '/repos/github-mcp-server', {
      countCotx(_repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT n.label')) return 10;
        if (query.includes("type:'CALLS'")) return 2787;
        throw new Error(`unexpected cotx query: ${query}`);
      },
      countGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT labels')) return 10;
        if (query.includes("type:'CALLS'")) return 2711;
        throw new Error(`unexpected GitNexus query: ${query}`);
      },
      queryRowCotx(_repoPath: string, query: string) {
        if (query.includes('dynamic_tools_test.go')) {
          return { calls: 0 };
        }
        if (query.includes('graphql_features.go')) {
          return { calls: 2 };
        }
        throw new Error(`unexpected cotx row query: ${query}`);
      },
      queryRowGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('dynamic_tools_test.go')) {
          return { calls: 1 };
        }
        if (query.includes('graphql_features.go')) {
          return { calls: 2 };
        }
        throw new Error(`unexpected GitNexus row query: ${query}`);
      },
    });
    const record = { repo: 'github-mcp-server', quality_probes: qualityProbes };

    expect(qualityProbes.go_newserver_precision).toMatchObject({
      cotx_false_positive_calls: 0,
      gitnexus_false_positive_calls: 1,
      classification: 'cotx-better',
    });
    expect(qualityProbes.go_graphql_features_coverage).toMatchObject({
      cotx_calls: 2,
      gitnexus_calls: 2,
      classification: 'both-valid',
    });
    expect(qualityProbeScoreContributions(record)).toEqual([1, 1]);
    expect(formatQualityProbeSummary([record])).toContain(
      '- github-mcp-server github_mcp_server_newserver_precision: cotx-better (direct-inspection-go-imported-call); verdict=cotx_does_not_overresolve_mcp_newserver_to_github_newserver; cotx false_positive_calls=0; GitNexus false_positive_calls=1.',
    );
  });

  it('keeps deer-flow Next.js route probes scoreable and classified', () => {
    const qualityProbes = runQualityProbes('deer-flow', '/repos/deer-flow', {
      countCotx(_repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT n.label')) return 10;
        throw new Error(`unexpected cotx query: ${query}`);
      },
      countGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT labels')) return 10;
        throw new Error(`unexpected GitNexus query: ${query}`);
      },
      queryRowCotx(_repoPath: string, query: string) {
        if (query.includes('HANDLES_ROUTE')) {
          return { handles: 3 };
        }
        if (query.includes(':Route')) {
          return { routes: 3 };
        }
        throw new Error(`unexpected cotx row query: ${query}`);
      },
      queryRowGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('HANDLES_ROUTE')) {
          return { handles: 0 };
        }
        if (query.includes(':Route')) {
          return { routes: 0 };
        }
        throw new Error(`unexpected GitNexus row query: ${query}`);
      },
    });
    const record = { repo: 'deer-flow', quality_probes: qualityProbes };

    expect(qualityProbes.nextjs_api_routes).toMatchObject({
      cotx_routes: 3,
      cotx_handles: 3,
      gitnexus_routes: 0,
      gitnexus_handles: 0,
      classification: 'cotx-better',
    });
    expect(qualityProbeScoreContributions(record)).toEqual([1]);
    expect(formatQualityProbeSummary([record])).toContain(
      '- deer-flow deer_flow_nextjs_api_routes: cotx-better (direct-inspection-nextjs-filesystem-routes); verdict=cotx_detects_deer_flow_nextjs_api_routes; cotx routes=3, handles=3; GitNexus routes=0, handles=0.',
    );
  });

  it('treats OpenHands shared route misses as non-comparative evidence', () => {
    const qualityProbes = runQualityProbes('OpenHands', '/repos/OpenHands', {
      countCotx(_repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT n.label')) return 16;
        throw new Error(`unexpected cotx query: ${query}`);
      },
      countGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT labels')) return 18;
        throw new Error(`unexpected GitNexus query: ${query}`);
      },
      queryRowCotx(_repoPath: string, query: string) {
        if (query.includes('HANDLES_ROUTE')) {
          return { handles: 2 };
        }
        if (query.includes('status_router.py')) {
          return { routes: 2 };
        }
        throw new Error(`unexpected cotx row query: ${query}`);
      },
      queryRowGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('HANDLES_ROUTE')) {
          return { handles: 2 };
        }
        if (query.includes('status_router.py')) {
          return { routes: 2 };
        }
        throw new Error(`unexpected GitNexus row query: ${query}`);
      },
    });
    const record = { repo: 'OpenHands', quality_probes: qualityProbes };

    expect(qualityProbes.openhands_status_router_coverage).toMatchObject({
      cotx_routes: 2,
      cotx_handles: 2,
      gitnexus_routes: 2,
      gitnexus_handles: 2,
      classification: 'both-miss',
    });
    expect(qualityProbes.verdicts.find((probe) => probe.id === 'openhands_status_router_coverage')).toMatchObject({
      verdict: 'openhands_status_routes_missing_in_both',
    });
    expect(qualityProbeScoreContributions(record)).toEqual([]);
    expect(formatQualityProbeSummary([record])).toContain(
      '- OpenHands openhands_status_router_coverage: both-miss (direct-inspection-fastapi-status-routes); verdict=openhands_status_routes_missing_in_both; cotx routes=2, handles=2; GitNexus routes=2, handles=2.',
    );
  });

  it('keeps runner-level quality rows neutral for OpenHands shared misses', () => {
    const qualityProbes = runQualityProbes('OpenHands', '/repos/OpenHands', {
      countCotx(_repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT n.label')) return 16;
        throw new Error(`unexpected cotx query: ${query}`);
      },
      countGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT labels')) return 18;
        throw new Error(`unexpected GitNexus query: ${query}`);
      },
      queryRowCotx(_repoPath: string, query: string) {
        if (query.includes('HANDLES_ROUTE')) return { handles: 2 };
        if (query.includes('status_router.py')) return { routes: 2 };
        throw new Error(`unexpected cotx row query: ${query}`);
      },
      queryRowGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('HANDLES_ROUTE')) return { handles: 2 };
        if (query.includes('status_router.py')) return { routes: 2 };
        throw new Error(`unexpected GitNexus row query: ${query}`);
      },
    });

    const row = summarizeQualityProbeRecord({
      repo: 'OpenHands',
      quality_probes: qualityProbes,
    });

    expect(row.status).toBe('ok');
    expect(row.primary).toBe(0);
    expect(row.notes).toContain('shared source-truth miss');
    expect(row.details.shared_truth_misses).toEqual([
      expect.objectContaining({
        id: 'openhands_status_router_coverage',
        classification: 'both-miss',
      }),
    ]);
    expect(row.details.comparative_issues).toEqual([]);
  });

  it('keeps ruff precision probes scoreable and classified', () => {
    const qualityProbes = runQualityProbes('ruff', '/repos/ruff', {
      countCotx(_repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 13;
        if (query.includes('DISTINCT n.label')) return 17;
        if (query.includes('METHOD_IMPLEMENTS')) return 1673;
        throw new Error(`unexpected cotx query: ${query}`);
      },
      countGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('DISTINCT r.type')) return 12;
        if (query.includes('DISTINCT labels')) return 19;
        if (query.includes('METHOD_IMPLEMENTS')) return 0;
        throw new Error(`unexpected GitNexus query: ${query}`);
      },
      queryRowCotx(_repoPath: string, query: string) {
        if (query.includes('generated.rs')) {
          return { calls: 396, targets: 34 };
        }
        if (query.includes('cancellation.rs')) {
          return { calls: 0 };
        }
        throw new Error(`unexpected cotx row query: ${query}`);
      },
      queryRowGitNexus(_repoName: string, _repoPath: string, query: string) {
        if (query.includes('generated.rs')) {
          return { calls: 253, targets: 1 };
        }
        if (query.includes('cancellation.rs')) {
          return { calls: 1 };
        }
        throw new Error(`unexpected GitNexus row query: ${query}`);
      },
    });
    const record = { repo: 'ruff', quality_probes: qualityProbes };

    expect(qualityProbes.generated_range_precision).toMatchObject({
      cotx_calls: 396,
      cotx_distinct_targets: 34,
      gitnexus_calls: 253,
      gitnexus_distinct_targets: 1,
      classification: 'cotx-better',
      verdict: 'cotx_preserves_generated_ast_range_variants',
    });
    expect(qualityProbes.rust_dispatch_depth).toMatchObject({
      cotx_method_implements: 1673,
      gitnexus_method_implements: 0,
      classification: 'cotx-better',
    });
    expect(qualityProbes.parsed_load_precision).toMatchObject({
      cotx_false_positive_calls: 0,
      gitnexus_false_positive_calls: 1,
      classification: 'cotx-better',
    });
    expect(qualityProbeScoreContributions(record)).toEqual([1, 1, 1]);
    expect(formatQualityProbeSummary([record])).toContain(
      '- ruff ruff_generated_range_precision: cotx-better (direct-inspection-generated-rust-range); verdict=cotx_preserves_generated_ast_range_variants; cotx calls=396, distinct_targets=34; GitNexus calls=253, distinct_targets=1.',
    );
  });
});
