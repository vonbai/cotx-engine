import { useContext } from 'react';
import { CotxContext } from '../provider/CotxProvider.js';
import type { CotxContextValue } from '../provider/CotxProvider.js';

/**
 * Access the cotx workbench state and actions from within a `<CotxProvider>`.
 *
 * @throws {Error} if called outside `<CotxProvider>`
 */
export function useCotxWorkbench(): Pick<CotxContextValue, 'state' | 'actions'> {
  const ctx = useContext(CotxContext);
  if (ctx === null) {
    throw new Error(
      'useCotxWorkbench must be used within a <CotxProvider>. ' +
        'Wrap your component tree with <CotxProvider adapter={...} projectId="...">.',
    );
  }
  return { state: ctx.state, actions: ctx.actions };
}
