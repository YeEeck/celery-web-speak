const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

export function shouldSuppressNativeContextMenu(event: MouseEvent) {
  if (event.defaultPrevented || !isMouseContextMenu(event)) return false

  const target = event.target instanceof Element ? event.target : null
  if (!target || preservesNativeContextMenu(target)) return false
  if (selectionContainsPoint(document.getSelection(), event.clientX, event.clientY)) return false

  return true
}

function isMouseContextMenu(event: MouseEvent) {
  if (event.button !== 2) return false
  if (event instanceof PointerEvent && event.pointerType) return event.pointerType === 'mouse'
  return true
}

function preservesNativeContextMenu(target: Element) {
  if (target.closest('a[href], textarea, [data-native-context-menu]')) return true

  const input = target.closest('input')
  if (input instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(input.type)) return true

  const editable = target.closest('[contenteditable]')
  if (editable instanceof HTMLElement && editable.isContentEditable) return true

  return false
}

function selectionContainsPoint(selection: Selection | null, clientX: number, clientY: number) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false

  const point = document.caretRangeFromPoint(clientX, clientY)
  if (!point) return false

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)
    try {
      if (range.isPointInRange(point.startContainer, point.startOffset)) return true
    } catch {
      // Ignore points from a different document tree.
    }
  }

  return false
}
