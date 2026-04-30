import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

const graphInstance = {
  render: vi.fn(),
  destroy: vi.fn(),
  setData: vi.fn(),
  updateBehavior: vi.fn(),
  on: vi.fn(),
  setElementState: vi.fn(),
  fitView: vi.fn(),
  zoomTo: vi.fn(),
  translateTo: vi.fn(),
};

vi.mock('@antv/g6', () => ({
  Graph: vi.fn(() => graphInstance),
}));
