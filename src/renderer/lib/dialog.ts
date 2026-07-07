// Wrappers over @tauri-apps/plugin-dialog. Tauri v2's WKWebView does NOT bridge
// window.confirm()/alert()/prompt() to native dialogs (those calls silently
// return false/undefined), so every confirm/alert must go through this plugin
// instead. All functions are async — callers must await them.

import { confirm, message } from '@tauri-apps/plugin-dialog';

/// Native confirm dialog. Returns true if the user accepted, false otherwise.
/// `title` defaults to a neutral '确认'; callers may pass a more specific one.
export async function confirmDialog(body: string, title = '确认'): Promise<boolean> {
  // kind: 'info' gives a neutral icon; okLabel/cancelLabel localize the macOS
  // buttons (the plugin defaults to English OK/Cancel otherwise).
  return confirm(body, { title, kind: 'info', okLabel: '确定', cancelLabel: '取消' });
}

/// Native message dialog (the replacement for window.alert). Returns when the
/// user dismisses it. `title` defaults to the app name.
export async function alertDialog(body: string, title = 'TermStep'): Promise<void> {
  await message(body, { title, kind: 'info', okLabel: '好' });
}
