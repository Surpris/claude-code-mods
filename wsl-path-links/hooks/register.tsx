import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Viewed } from '../types'

// Local paths in Claude's replies become links. A plain click on one is
// answered here (fullscreen terminal): a file is shown in a viewer pane
// beside the transcript, as /diff shows its diff; a directory opens in
// Windows Explorer as \\wsl.localhost\<distro>\... .

const PANE = 'wsl-path-viewer'
const viewed = atom({ plugin: 'wsl-path-links', key: 'viewed' } as const, null as Viewed, {
  shape: 'viewed-1',
})

// Top-level directories a path must start with to be linked, so slash
// commands such as /diff or /plugin stay plain text.
const ROOTS = 'home|tmp|mnt|etc|usr|var|opt|root|srv|media|run|snap|workspace|workspaces'
const PATH = String.raw`(?:~(?=/)|/(?:${ROOTS})(?![A-Za-z0-9._\-]))(?:/[A-Za-z0-9._\-~@+%=,]+)*/?`
const LEAD = String.raw`(?:^|(?<=[^A-Za-z0-9._\-~/:\x60]))`
const LINE_SUFFIX = String.raw`(?::\d+){0,2}`

// One inline token: a markdown link, a code span, bold text, or a bare path.
const TOKEN = new RegExp(
  [
    String.raw`\[(?<label>[^\]\n]*)\]\((?<href>[^)\s]+)\)`,
    String.raw`\x60(?<code>[^\x60\n]+)\x60`,
    String.raw`\*\*(?<bold>[^*\n]+)\*\*`,
    String.raw`${LEAD}(?<path>${PATH})(?<suffix>${LINE_SUFFIX})`,
  ].join('|'),
  'g',
)
const WHOLE = new RegExp(String.raw`^(${PATH})(${LINE_SUFFIX})$`)

export type LinkOptions = { distro: string; home: string }

function absolute(path: string, { home }: LinkOptions): string {
  return path.startsWith('~') ? home + path.slice(1) : path
}

function fileUrl(path: string): string {
  return 'file://' + path.split('/').map(encodeURIComponent).join('/')
}

// A sentence-ending dot or comma is not part of the path.
function trimTrail(path: string): string {
  return path.replace(/[.,]+$/, '')
}

// The local path a pressed link names, whatever form the surface drew it in.
export function pathOfHref(href: string, { distro }: LinkOptions): string | null {
  if (!href.startsWith('file:')) return null
  let path = decodeURIComponent(href.replace(/^file:\/\/[^/]*/, '').replace(/[?#].*$/, ''))
  const unc = `/${distro}/`
  if (/^file:\/\/wsl(\.localhost|\$)\//i.test(href) && path.startsWith(unc)) path = path.slice(unc.length - 1)
  return path || null
}

// Rewrites each local path in a markdown block as a file: link.
export function linkPaths(markdown: string, o: LinkOptions): string {
  let inFence = false
  return markdown
    .split('\n')
    .map(line => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
      if (inFence || /^\s*(```|~~~)/.test(line)) return line
      return line.replace(TOKEN, (m, ...args) => {
        const g = args[args.length - 1] as Record<string, string | undefined>
        if (g.href !== undefined) {
          const local = g.href.match(/^file:\/\/(\/[^?#]*)$/)
          return local ? `[${g.label}](${fileUrl(decodeURIComponent(local[1] ?? ''))})` : m
        }
        if (g.code !== undefined) {
          const hit = g.code.match(WHOLE)
          return hit ? `[${m}](${fileUrl(absolute(trimTrail(hit[1] ?? ''), o))})` : m
        }
        if (g.path !== undefined) {
          const clean = trimTrail(g.path)
          return `[${clean}${g.suffix ?? ''}](${fileUrl(absolute(clean, o))})${g.path.slice(clean.length)}`
        }
        return m
      })
    })
    .join('\n')
}

// Text the terminal can draw: control characters other than tab and newline
// become U+FFFD, and a file with NUL bytes is called binary.
export function drawable(text: string): string | null {
  if (text.includes('\u0000')) return null
  return text.replace(/\r\n/g, '\n').replace(/[\u0001-\u0008\u000b-\u001f\u007f]/g, '\ufffd')
}

let options: LinkOptions | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const distro = await $.env.get('WSL_DISTRO_NAME')
    const home = (await $.env.get('HOME')) ?? ''
    options = distro ? { distro, home } : undefined
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const o = options
    if (!o || e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const text = linkPaths(e.props.text, o)
    if (text === e.props.text) return next(e)

    const { Box, Text, Markdown } = $.ui.resolve(e)

    const press = async (href: string) => {
      const path = pathOfHref(href, o)
      if (!path) {
        if (/^https?:/.test(href)) await $.process.run(['explorer.exe', href])
        return
      }
      try {
        const stat = await $.fs.stat(path)
        if (stat.kind === 'dir') {
          const win = `\\\\wsl.localhost\\${o.distro}${path.replace(/\//g, '\\')}`
          await $.process.run(['explorer.exe', win])
          return
        }
        await update($, viewed, () => ({ path }))
        await $.ui.open({ id: PANE, title: path.split('/').pop() || path })
      } catch (err) {
        $.ui.toast(`${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Markdown key={`reply-${e.requestId}`} text={text} onLinkPress={link => void press(link.href)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Code } = $.ui.resolve(e)
    const shown = await read($, viewed)
    if (!shown) return <Text dimColor>Click a file path in a reply to show it here.</Text>

    let body
    try {
      const stat = await $.fs.stat(shown.path)
      if (stat.size > 4 * 1024 * 1024) {
        body = <Text dimColor>The file is over 4 MiB and is not shown.</Text>
      } else {
        const source = drawable(await $.fs.read(shown.path))
        body =
          source === null ? (
            <Text dimColor>A binary file is not shown.</Text>
          ) : (
            <Code source={source} path={shown.path} startLine={1} />
          )
      }
    } catch (err) {
      body = <Text color="error">{err instanceof Error ? err.message : String(err)}</Text>
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{shown.path}</Text>
        {body}
      </Box>
    )
  })
}
