// ═════════════════════════════════════════════════════════════
// lib/tools/interact.js
// DOM interaction tools aggregator - factory pattern
// Requires dependencies: log, session, wsBroadcast, emitThinking, etc.
// ═════════════════════════════════════════════════════════════

const createInteractClickTools = require('./interact-click');
const createInteractFillTools = require('./interact-fill');
const createInteractKeyboardTools = require('./interact-keyboard');
const createInteractSelectTools = require('./interact-select');
const createInteractDragUploadTools = require('./interact-drag-upload');

module.exports = function createInteractTools(deps) {
  const clickTools = createInteractClickTools(deps);
  const fillTools = createInteractFillTools(deps);
  const keyboardTools = createInteractKeyboardTools(deps);
  const selectTools = createInteractSelectTools(deps);
  const dragUploadTools = createInteractDragUploadTools(deps);

  return {
    // Click & form
    toolClickElement: clickTools.toolClickElement,
    toolFillForm: fillTools.toolFillForm,

    // Keyboard
    toolTypeHuman: keyboardTools.toolTypeHuman,
    toolPressKey: keyboardTools.toolPressKey,
    toolKeyCombo: keyboardTools.toolKeyCombo,
    toolClipboardWrite: keyboardTools.toolClipboardWrite,

    // Select & dropdown
    toolSelectOption: selectTools.toolSelectOption,
    toolSelectDropdown: selectTools.toolSelectDropdown,
    toolSetDatepicker: selectTools.toolSetDatepicker,

    // Drag & upload
    toolDragDrop: dragUploadTools.toolDragDrop,
    toolUploadFile: dragUploadTools.toolUploadFile,

    // Note: toolSubmitForm extracted from click_element flow (no dedicated case in switch statement)
    toolSubmitForm: async (args) => JSON.stringify({ error: 'submit_form not implemented — use fill_form + click_element' })
  };
};
