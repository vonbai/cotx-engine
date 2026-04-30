/**
 * PageRank — power iteration on a directed graph.
 *
 * Supports personalized PageRank: if focusNodes are provided,
 * the random surfer teleports to those nodes instead of uniformly.
 */

export interface PageRankOptions {
  damping?: number;      // Default: 0.85
  iterations?: number;   // Default: 50
  tolerance?: number;    // Default: 1e-6 (early stop if max delta < tolerance)
}

/**
 * Compute PageRank scores for a directed graph.
 *
 * @param nodeIds - all node IDs in the graph
 * @param outEdges - map from nodeId → list of outgoing neighbor IDs
 * @param focusNodes - optional personalization set (teleport targets)
 * @param options - damping, iterations, tolerance
 * @returns Map<nodeId, score> where scores sum to 1.0
 */
export function pageRank(
  nodeIds: string[],
  outEdges: Map<string, string[]>,
  focusNodes?: string[],
  options?: PageRankOptions,
): Map<string, number> {
  const N = nodeIds.length;
  if (N === 0) return new Map();

  const damping = options?.damping ?? 0.85;
  const maxIterations = options?.iterations ?? 50;
  const tolerance = options?.tolerance ?? 1e-6;

  // Build index: id → index
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    idToIndex.set(nodeIds[i], i);
  }

  // Build adjacency: outgoing edges as indices
  const outDegree = new Float64Array(N);
  const adjList: number[][] = new Array(N);
  for (let i = 0; i < N; i++) adjList[i] = [];

  for (let i = 0; i < N; i++) {
    const id = nodeIds[i];
    const neighbors = outEdges.get(id) ?? [];
    const validNeighbors: number[] = [];
    for (const nid of neighbors) {
      const j = idToIndex.get(nid);
      if (j !== undefined && j !== i) {
        validNeighbors.push(j);
      }
    }
    adjList[i] = validNeighbors;
    outDegree[i] = validNeighbors.length;
  }

  // Build incoming adjacency for efficient iteration
  const inList: number[][] = new Array(N);
  for (let i = 0; i < N; i++) inList[i] = [];
  for (let i = 0; i < N; i++) {
    for (const j of adjList[i]) {
      inList[j].push(i);
    }
  }

  // Personalization vector
  const personalization = new Float64Array(N);
  if (focusNodes && focusNodes.length > 0) {
    const validFocus = new Set<number>();
    for (const id of focusNodes) {
      const idx = idToIndex.get(id);
      if (idx !== undefined) validFocus.add(idx);
    }
    if (validFocus.size > 0) {
      const focusWeight = 1.0 / validFocus.size;
      for (const idx of validFocus) {
        personalization[idx] = focusWeight;
      }
    } else {
      const uniform = 1.0 / N;
      for (let i = 0; i < N; i++) personalization[i] = uniform;
    }
  } else {
    const uniform = 1.0 / N;
    for (let i = 0; i < N; i++) personalization[i] = uniform;
  }

  // Initialize scores
  let scores = new Float64Array(N);
  for (let i = 0; i < N; i++) scores[i] = 1.0 / N;

  // Power iteration
  for (let iter = 0; iter < maxIterations; iter++) {
    const newScores = new Float64Array(N);

    // Dangling node mass (nodes with no outgoing edges)
    let danglingMass = 0;
    for (let i = 0; i < N; i++) {
      if (outDegree[i] === 0) danglingMass += scores[i];
    }

    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (const j of inList[i]) {
        sum += scores[j] / outDegree[j];
      }
      newScores[i] =
        (1 - damping) * personalization[i] +
        damping * (sum + danglingMass * personalization[i]);
    }

    // Check convergence
    let maxDelta = 0;
    for (let i = 0; i < N; i++) {
      const delta = Math.abs(newScores[i] - scores[i]);
      if (delta > maxDelta) maxDelta = delta;
    }

    scores = newScores;
    if (maxDelta < tolerance) break;
  }

  // Convert to Map
  const result = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    result.set(nodeIds[i], scores[i]);
  }

  return result;
}
