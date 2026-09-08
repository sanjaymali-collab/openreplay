/**
 * Find every <canvas> that lives inside an *open* shadow root under `root`
 * (recursively — nested shadow roots included). Light-DOM canvases are not
 * returned; the tracker's own node callbacks already cover those.
 *
 * Closed shadow roots are not reachable from script and are skipped, which is
 * the correct privacy outcome: a host that hides its subtree cannot be streamed.
 */
export function findShadowRootCanvases(root: ParentNode = document): HTMLCanvasElement[] {
  const found: HTMLCanvasElement[] = []
  const seen = new Set<ParentNode>()
  const walk = (node: ParentNode) => {
    if (seen.has(node)) return
    seen.add(node)
    let hosts: NodeListOf<Element>
    try {
      hosts = node.querySelectorAll('*')
    } catch {
      return
    }
    hosts.forEach((el) => {
      const shadow = el.shadowRoot
      if (!shadow) return
      shadow.querySelectorAll('canvas').forEach((c) => found.push(c))
      walk(shadow)
    })
  }
  walk(root)
  return found
}
