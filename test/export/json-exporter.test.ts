import { describe, it, expect } from 'vitest';
import { exportGraphToJsonLines, exportCommunitiesToJsonLines, exportProcessesToJsonLines } from '../../src/core/export/json-exporter.js';

describe('exportGraphToJsonLines', () => {
  it('exports nodes as JSON lines', () => {
    const mockGraph = {
      nodes: [
        { id: 'func_main', label: 'Function', properties: { name: 'main', filePath: 'main.go', startLine: 1, endLine: 10, isExported: true } },
        { id: 'func_handle', label: 'Function', properties: { name: 'handleRequest', filePath: 'handler.go', startLine: 5, endLine: 20, isExported: true } },
      ],
      edges: [
        { sourceId: 'func_main', targetId: 'func_handle', type: 'CALLS', confidence: 0.95 },
      ],
    };

    const result = exportGraphToJsonLines(mockGraph);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(JSON.parse(result.nodes[0])).toHaveProperty('id', 'func_main');
    expect(JSON.parse(result.edges[0])).toHaveProperty('type', 'CALLS');
  });

  it('exports communities as JSON lines', () => {
    const mockCommunities = [
      { id: 'comm_0', label: 'api', symbolCount: 5, cohesion: 0.8, members: ['func_main', 'func_handle'] },
    ];

    const result = exportCommunitiesToJsonLines(mockCommunities);

    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0])).toHaveProperty('symbolCount', 5);
  });

  it('exports processes as JSON lines', () => {
    const mockProcesses = [
      {
        id: 'proc_1',
        label: 'main_flow',
        processType: 'cross_community',
        stepCount: 3,
        communities: ['comm_0', 'comm_1'],
        entryPointId: 'func_main',
        terminalId: 'func_db',
        steps: [{ nodeId: 'func_main', step: 1 }, { nodeId: 'func_handle', step: 2 }, { nodeId: 'func_db', step: 3 }],
      },
    ];

    const result = exportProcessesToJsonLines(mockProcesses);

    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]);
    expect(parsed.stepCount).toBe(3);
    expect(parsed.steps).toHaveLength(3);
  });

  it('handles empty graph', () => {
    const result = exportGraphToJsonLines({ nodes: [], edges: [] });
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});
