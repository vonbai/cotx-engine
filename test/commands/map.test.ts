import { describe, it, expect } from 'vitest';
import { getOpenCommand } from '../../src/commands/map.js';

describe('getOpenCommand', () => {
  it('uses cmd.exe start on win32 so browser opening works', () => {
    expect(getOpenCommand('win32', 'C:\\temp\\cotx-map.html')).toEqual({
      command: 'cmd.exe',
      args: ['/c', 'start', '', 'C:\\temp\\cotx-map.html'],
    });
  });

  it('uses xdg-open on linux', () => {
    expect(getOpenCommand('linux', '/tmp/cotx-map.html')).toEqual({
      command: 'xdg-open',
      args: ['/tmp/cotx-map.html'],
    });
  });
});
