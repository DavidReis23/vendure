// The plugin is imported by package name; in a monorepo this resolves through
// a node_modules symlink to a workspace package (set up at runtime by the spec).
import { TestWorkspacePlugin } from 'test-workspace-plugin';

export const config = {
    plugins: [TestWorkspacePlugin],
};
