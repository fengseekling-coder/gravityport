/**
 * Keyboard-scope guard: text entry surfaces (inputs, textareas, selects and
 * contenteditable regions) own keys like Backspace/Delete/⌘A — the gallery
 * shortcuts must never fire while the user is typing or selecting text.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || !!target.closest("input, textarea, select")
}
