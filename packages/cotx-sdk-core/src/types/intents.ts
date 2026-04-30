import type { ExplorerNodePath } from './explorer.js';
import type { WorkbenchState } from '../state/workbench-state.js';

export interface WriteIntent {
  nodePath: ExplorerNodePath;
  field: string;
}

export interface RefactorIntent {
  nodePath: ExplorerNodePath;
  action: 'rename' | 'split' | 'merge' | 'impact';
}

export interface AgentIntent {
  nodePath?: ExplorerNodePath;
  task: string;
}

export interface ToolIntent {
  toolName: string;
  args: Record<string, unknown>;
}

export interface PersistViewIntent {
  label: string;
  state: WorkbenchState;
}

export interface CompareIntent {
  left: ExplorerNodePath | null;
  right: ExplorerNodePath | null;
}

export interface WorkbenchIntents {
  onWriteIntent?: (intent: WriteIntent) => void | Promise<void>;
  onRefactorIntent?: (intent: RefactorIntent) => void | Promise<void>;
  onAgentIntent?: (intent: AgentIntent) => void | Promise<void>;
  onRunToolIntent?: (intent: ToolIntent) => void | Promise<void>;
  onPersistViewIntent?: (intent: PersistViewIntent) => void | Promise<void>;
  onCompareIntent?: (intent: CompareIntent) => void | Promise<void>;
}
