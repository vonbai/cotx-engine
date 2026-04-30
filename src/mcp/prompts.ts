export interface CotxPromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
}

export const COTX_PROMPTS: CotxPromptDefinition[] = [
  {
    name: 'cotx_onboard_agent',
    title: 'Onboard Agent',
    description: 'Start with bounded workspace scan and onboarding context before graph-backed analysis.',
    arguments: [
      { name: 'project_root', description: 'Absolute project root path', required: true },
      { name: 'task', description: 'Task or question for onboarding', required: false },
    ],
  },
  {
    name: 'cotx_architecture_scan',
    title: 'Architecture Scan',
    description: 'Inspect canonical architecture context without reading the full repository.',
    arguments: [
      { name: 'project_root', description: 'Absolute project root path', required: true },
      { name: 'focus', description: 'Architecture focus term, component, package, or file', required: false },
    ],
  },
  {
    name: 'cotx_enrich_architecture',
    title: 'Enrich Architecture',
    description: 'Generate evidence-backed architecture enrichment drafts through cotx write APIs.',
    arguments: [
      { name: 'project_root', description: 'Absolute project root path', required: true },
      { name: 'target', description: 'Canonical architecture element or perspective id', required: true },
    ],
  },
  {
    name: 'cotx_pre_merge_check',
    title: 'Pre-Merge Check',
    description: 'Review current changes with graph-backed impact and project doctrine.',
    arguments: [
      { name: 'project_root', description: 'Absolute project root path', required: true },
    ],
  },
  {
    name: 'cotx_review_changes',
    title: 'Review Changes',
    description: 'Map changed files to graph symbols and review risk before editing or merging.',
    arguments: [
      { name: 'project_root', description: 'Absolute project root path', required: true },
      { name: 'files', description: 'Optional comma-separated changed files', required: false },
    ],
  },
  {
    name: 'cotx_codrive_workflow',
    title: 'Co-Drive Workflow',
    description: 'Run the full bounded co-driving workflow from onboarding through planning, impact review, and explanation.',
    arguments: [
      { name: 'project_root', description: 'Absolute project root path', required: true },
      { name: 'task', description: 'Task, question, or intended change', required: true },
      { name: 'files', description: 'Optional comma-separated changed files', required: false },
    ],
  },
];

export function getCotxPrompt(name: string, args: Record<string, string | undefined>): { description: string; messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } | null {
  const def = COTX_PROMPTS.find((prompt) => prompt.name === name);
  if (!def) return null;
  const projectRoot = args.project_root ?? '<project_root>';
  const task = args.task ?? args.focus ?? args.target ?? 'the requested task';
  const files = args.files ?? '';
  const text = promptText(name, { projectRoot, task, files });
  return {
    description: def.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

function promptText(name: string, input: { projectRoot: string; task: string; files: string }): string {
  const common = [
    `Project root: ${input.projectRoot}`,
    'Use cotx tools instead of reading the full repository.',
    'Start with cotx_prepare_task unless the needed cotx result is already available.',
    'Do not treat LLM text as graph truth. Route writes through cotx_write and preserve evidence anchors.',
  ];

  if (name === 'cotx_onboard_agent') {
    return [
      ...common,
      `Task: ${input.task}`,
      'Workflow:',
      '1. Call cotx_prepare_task with the task.',
      '2. If phase=enrich, follow the recommended_next_tools before broad code reading.',
      '3. Use cotx_query/cotx_context only for selected graph-backed targets.',
      '4. Summarize confirmed, contradicted, graph-gap, stale-doc, unknown findings, and the enrichment recommendation.',
    ].join('\n');
  }

  if (name === 'cotx_architecture_scan') {
    return [
      ...common,
      `Focus: ${input.task}`,
      'Workflow:',
      '1. Call cotx_prepare_task with budget=standard and focus set to the architecture term.',
      '2. If enrichment is recommended, enrich only the selected architecture scope.',
      '3. Call cotx_map with scope=architecture.',
      '4. Use cotx_query with layer=architecture for a targeted component search.',
      '5. Use cotx_context on one selected architecture/<path> node.',
    ].join('\n');
  }

  if (name === 'cotx_enrich_architecture') {
    return [
      ...common,
      `Target: ${input.task}`,
      'Workflow:',
      '1. Call cotx_context on the target architecture node or inspect .cotx/architecture/workspace.json through cotx_map.',
      '2. Draft enrichment only from evidence anchors in the returned context.',
      '3. Validate that every claim maps to file/node/relation/process/route/tool/decision evidence.',
      '4. Write only enrichment fields through cotx_write; do not create truth graph facts.',
    ].join('\n');
  }

  if (name === 'cotx_pre_merge_check') {
    return [
      ...common,
      'Workflow:',
      '1. Call cotx_detect_changes with scope=all.',
      '2. Call cotx_review_change.',
      '3. For API changes, call cotx_api_impact on relevant routes or handler files.',
      '4. Return blockers, warnings, and missing validation.',
    ].join('\n');
  }

  if (name === 'cotx_codrive_workflow') {
    return [
      ...common,
      `Task: ${input.task}`,
      `Changed files: ${input.files || '(use git diff)'}`,
      'Workflow:',
      '1. Call cotx_prepare_task with the task, focus, changed_files if known, and budget=standard.',
      '2. If phase=enrich, follow the recommended_next_tools before editing.',
      '3. For architecture work, call cotx_map with scope=architecture, then cotx_query with layer=architecture and cotx_context on one selected architecture node.',
      '4. For code, route, or tool work, call cotx_query, cotx_context, cotx_route_map, cotx_tool_map, or cotx_api_impact only for selected graph-backed targets.',
      '5. Before editing, call cotx_plan_change with the task target and human intent.',
      '6. After editing, call cotx_detect_changes and cotx_review_change; if cotx_prepare_task still reports typed-graph-unavailable or bootstrap phase, say typed change impact is blocked until cotx_compile creates storage-v2 truth, then still run cotx_review_change for doctrine-backed review.',
      '7. Use cotx_api_impact for changed route handlers when typed graph data is available.',
      '8. Explain the result with evidence, stale-doc/graph-gap/unknown state, enrichment decision, remaining risks, and the next validation command.',
    ].join('\n');
  }

  return [
    ...common,
    `Changed files: ${input.files || '(use git diff)'}`,
    'Workflow:',
    '1. Call cotx_detect_changes.',
    '2. Call cotx_review_change.',
    '3. Use cotx_context/cotx_impact only for high-risk changed symbols.',
    '4. Report findings first, ordered by severity.',
  ].join('\n');
}
