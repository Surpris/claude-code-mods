// The file the viewer pane shows, or null before any file was clicked.
export type Viewed = { path: string } | null

declare module 'claude-code' {
  interface PluginState {
    'wsl-path-links': { viewed: Shaped<Viewed> }
  }
}
