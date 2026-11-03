'use strict';
/* Presses and releases one key (or mouse side button) on this computer.
   Used only for "Auto push-to-talk": hold your Discord push-to-talk key while a sound plays.
   Windows: user32 keybd_event / mouse_event. Mac: CoreGraphics events (needs Accessibility). */

// KeyboardEvent.code -> Windows virtual-key code
const WIN_VK = {
  Space: 0x20, Tab: 0x09, Enter: 0x0d, CapsLock: 0x14, Backspace: 0x08,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5,
  Backquote: 0xc0, Minus: 0xbd, Equal: 0xbb, BracketLeft: 0xdb, BracketRight: 0xdd, Backslash: 0xdc,
  Semicolon: 0xba, Quote: 0xde, Comma: 0xbc, Period: 0xbe, Slash: 0xbf,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
};
for (let i = 0; i < 26; i++) WIN_VK['Key' + String.fromCharCode(65 + i)] = 0x41 + i;
for (let i = 0; i < 10; i++) { WIN_VK['Digit' + i] = 0x30 + i; WIN_VK['Numpad' + i] = 0x60 + i; }
for (let i = 1; i <= 24; i++) WIN_VK['F' + i] = 0x6f + i;
const WIN_EXTENDED = new Set(['ControlRight', 'AltRight', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'NumpadDivide']);

// KeyboardEvent.code -> macOS virtual keycode
const MAC_KC = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12,
  KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22,
  Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31,
  KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40, Semicolon: 41,
  Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50,
  CapsLock: 57, ShiftLeft: 56, ControlLeft: 59, AltLeft: 58, ShiftRight: 60, AltRight: 61, ControlRight: 62,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
  F13: 105, F14: 107, F15: 113, F16: 106, F17: 64, F18: 79, F19: 80, F20: 90,
  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87, Numpad6: 88, Numpad7: 89,
  Numpad8: 91, Numpad9: 92, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
};

function createKeySender({ platform = process.platform, loadKoffi = () => require('koffi'), systemPreferences = null } = {}) {
  let impl = null;
  let loadError = null;

  function load() {
    if (impl || loadError) return impl;
    try {
      const koffi = loadKoffi();
      if (platform === 'win32') {
        const user32 = koffi.load('user32.dll');
        const keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
        const mouse_event = user32.func('void __stdcall mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, int32_t dwData, uintptr_t dwExtraInfo)');
        const MapVirtualKeyW = user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t uCode, uint32_t uMapType)');
        impl = {
          send(code, down) {
            if (code === 'Mouse4' || code === 'Mouse5') {
              mouse_event(down ? 0x0080 : 0x0100, 0, 0, code === 'Mouse4' ? 1 : 2, 0);
              return;
            }
            const vk = WIN_VK[code];
            if (vk === undefined) throw new Error('That key can\'t be pressed automatically: ' + code);
            const scan = MapVirtualKeyW(vk, 0) & 0xff;
            const flags = (WIN_EXTENDED.has(code) ? 0x1 : 0) | (down ? 0 : 0x2);
            keybd_event(vk, scan, flags, 0);
          },
        };
      } else if (platform === 'darwin') {
        const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
        const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
        const CGEventCreateKeyboardEvent = cg.func('void* CGEventCreateKeyboardEvent(void* source, uint16_t keycode, bool keyDown)');
        const CGEventPost = cg.func('void CGEventPost(uint32_t tap, void* event)');
        const CFRelease = cf.func('void CFRelease(void* cf)');
        impl = {
          send(code, down) {
            const kc = MAC_KC[code];
            if (kc === undefined) throw new Error('That key can\'t be pressed automatically on Mac: ' + code);
            const ev = CGEventCreateKeyboardEvent(null, kc, down);
            CGEventPost(0, ev);
            CFRelease(ev);
          },
        };
      } else {
        throw new Error('Auto push-to-talk works on Windows and Mac.');
      }
    } catch (e) {
      loadError = e;
      impl = null;
    }
    return impl;
  }

  function status() {
    load();
    if (!impl) return { available: false, reason: loadError ? loadError.message : 'unavailable' };
    if (platform === 'darwin' && systemPreferences && !systemPreferences.isTrustedAccessibilityClient(false)) {
      return { available: true, needsPermission: true };
    }
    return { available: true };
  }

  function press(code, down) {
    if (platform === 'darwin' && systemPreferences && !systemPreferences.isTrustedAccessibilityClient(false)) {
      systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS permission prompt
      throw new Error('Allow Echo Board under System Settings → Privacy & Security → Accessibility, then try again.');
    }
    const k = load();
    if (!k) throw new Error(loadError ? loadError.message : 'Key presses are unavailable.');
    k.send(String(code), !!down);
  }

  return { press, status };
}

module.exports = { createKeySender, WIN_VK, MAC_KC };
